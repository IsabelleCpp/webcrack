import type { NodePath } from '@babel/traverse';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import { renameFast } from '../ast-utils';

export interface EncryptedStringMap {
    path: NodePath<t.Node>;
    references: NodePath[] | null;
    name: string;
    originalName: string;
    mapName: string;
    cacheName: string | null;
}

/**
 * Finds an obfuscated keyed hex->xor string map and its decoder function.
 *
 * Pattern summary (descriptive names used instead of obfuscated identifiers):
 *
 *   // mapObject: holds entries keyed by a short identifier. Each entry is an
 *   // object that contains a hex payload string (e.g. payloadHex).
 *   const mapObject = {
 *     keyA: { payloadHex: '6173736574', otherProp: 'chunk-...' },
 *     keyB: { payloadHex: '011205041e1819', ... },
 *   };
 *
 *   // cacheObject: memoization cache used by the decoder to avoid re-decoding
 *   const cacheObject = {};
 *
 *   // decodeKeyedHexXor: decoder function created/assigned at runtime. The
 *   // obfuscator gives this a random name (e.g., WmNnWwwM) which changes per build.
 *   // We use the descriptive name `decodeKeyedHexXor` in comments to explain its role.
 *   decodeKeyedHexXor = function(key) {
 *     if (cacheObject[key]) {
 *       return cacheObject[key];
 *     } else {
 *       // Steps performed by the decoder:
 *       // 1. Look up the entry in mapObject by key: mapObject[key].payloadHex
 *       // 2. Split the hex string into byte pairs and parse each pair as hex.
 *       // 3. For each parsed byte `B`, the decoder XOR-folds `B` with the
 *       //    character codes of the key string. Concretely, if the key's
 *       //    character codes are `c1, c2, ..., cn`, the result is:
 *       //      decodedByte = B ^ c1 ^ c2 ^ ... ^ cn
 *       //    (the implementation performs this as a reduce starting from `B`).
 *       // 4. Convert resulting bytes to characters and join into the decoded string.
 *       // 5. Store the decoded string in cacheObject[key] and return it.
 *       return (cacheObject[key] = mapObject[key].payloadHex
 *         .match(/.{1,2}/g)
 *         .map((b) => parseInt(b, 16))
 *         .map((byte) =>
 *           key
 *             .split('')
 *             .map((ch) => ch.charCodeAt(0))
 *             .reduce((acc, code) => acc ^ code, byte),
 *         )
 *         .map((c) => String.fromCharCode(c))
 *         .join(''));
 *     }
 *   };
 *
 * What this finder does
 * ---------------------
 * - Detects the `mapObject` variable declaration that contains nested objects
 *   with string properties (heuristic: hex payloads).
 * - Optionally detects a nearby `cacheObject` declaration (an empty object used
 *   for memoization).
 * - Locates the decoder function assignment (the obfuscated function that
 *   performs the hex->bytes, XOR-with-key, char conversion, and caching).
 * - Renames the decoder binding to `__ENCRYPTED_STRING_MAP_DECODER__` (if a
 *   binding exists) to make later transformations easier.
 *
 * Notes and limitations
 * ---------------------
 * - The matcher is intentionally heuristic: it looks for a map object with
 *   nested string properties, an optional empty object used as a cache, and a
 *   function assignment that returns a `join('')` result assigned into the
 *   cache. Variants of the decoding chain may require tightening the matcher.
 * - After detection you can evaluate the map entries and inline decoded
 *   literals, or transform calls to the decoder into string literals.
 */
export function findEncryptedStringMap(ast: t.Node): EncryptedStringMap | undefined {
    let result: EncryptedStringMap | undefined;

    const decoderName = m.capture(m.identifier());
    const mapIdentifier = m.capture(m.identifier());
    const cacheIdentifier = m.capture(m.identifier());
    const mapObject = m.capture(m.objectExpression(m.anything()));

    // var/const/let <mapIdentifier> = { ... };
    const mapVarDecl = m.variableDeclaration(undefined, [
        m.variableDeclarator(m.fromCapture(mapIdentifier), m.fromCapture(mapObject)),
    ]);

    // var/const/let <cacheIdentifier> = {};
    const cacheVarDecl = m.variableDeclaration(undefined, [
        m.variableDeclarator(m.fromCapture(cacheIdentifier), m.objectExpression([])),
    ]);

    // decoder assignment: <decoderName> = function (key) { if (cache[key]) return cache[key]; else return (cache[key] = ... .join('')); }
    const decoderAssignment = m.assignmentExpression(
        '=',
        // left side is the captured identifier node
        m.fromCapture(decoderName),
        m.functionExpression(
            undefined,
            [m.identifier()], // accept any single identifier param
            m.blockStatement([
                m.ifStatement(
                    // if (cache[key])  -- computed member expression
                    m.memberExpression(m.fromCapture(cacheIdentifier), m.anything(), true),
                    // then { return cache[key]; }
                    m.blockStatement([
                        m.returnStatement(m.memberExpression(m.fromCapture(cacheIdentifier), m.anything(), true)),
                    ]),
                    // else { return (cache[key] = ... .join('')); }
                    m.blockStatement([
                        m.returnStatement(
                            m.assignmentExpression(
                                '=',
                                m.memberExpression(m.fromCapture(cacheIdentifier), m.anything(), true),
                                m.callExpression(
                                    // callee is something.join(...)
                                    m.memberExpression(m.anything(), m.anything(), false),
                                    [m.stringLiteral('')],
                                ),
                            ),
                        ),
                    ]),
                ),
            ]),
        ),
    );

    // alternative: var <decoderName> = function (key) { ... };
    const decoderVarDecl = m.variableDeclaration(undefined, [
        m.variableDeclarator(
            m.fromCapture(decoderName),
            m.functionExpression(undefined, [m.identifier()], m.blockStatement(m.anything())),
        ),
    ]);

    traverse(ast, {
        VariableDeclaration(path) {
            if (result) return;

            if (!mapVarDecl.match(path.node)) return;

            const obj = mapObject.current as t.ObjectExpression | undefined;
            if (!obj) return;

            // Heuristic: at least one property value is an object with a string property (likely the hex payload)
            const hasHexLike = obj.properties.some((p) => {
                if (!t.isObjectProperty(p) || !t.isObjectExpression(p.value)) return false;
                return p.value.properties.some((pp) => t.isObjectProperty(pp) && t.isStringLiteral(pp.value));
            });
            if (!hasHexLike) return;

            // Try to find a nearby cache declaration (y = {}) in the same parent block
            let foundCacheName: string | null = null;
            const parent = path.parentPath;
            if (parent && parent.node && Array.isArray((parent.node as any).body)) {
                for (const stmt of (parent.node as any).body as t.Statement[]) {
                    if (cacheVarDecl.match(stmt)) {
                        foundCacheName = cacheIdentifier.current!.name;
                        break;
                    }
                }
            }

            // Search for the decoder assignment in the same block/siblings
            let decoderPath: NodePath<any> | null = null;
            path.findParent((p) => {
                if (p.node && (t.isProgram(p.node) || t.isBlockStatement(p.node))) {
                    const body = (p.node as t.Program | t.BlockStatement).body;
                    for (let i = 0; i < body.length; i++) {
                        const stmt = body[i];
                        if (t.isExpressionStatement(stmt) && decoderAssignment.match(stmt.expression)) {
                            decoderPath = (p.get('body') as NodePath[])[i] as NodePath<any>;
                            break;
                        }
                        if (t.isVariableDeclaration(stmt) && decoderVarDecl.match(stmt)) {
                            decoderPath = (p.get('body') as NodePath[])[i] as NodePath<any>;
                            break;
                        }
                    }
                }
                return !!decoderPath;
            });

            // Fallback: search the subtree for an assignment/function that matches and references the map identifier
            if (!decoderPath) {
                path.traverse({
                    AssignmentExpression(innerPath) {
                        if (decoderAssignment.match(innerPath.node)) {
                            // ensure the function references the map identifier somewhere
                            let referencesMap = false;
                            innerPath.traverse({
                                MemberExpression(mePath) {
                                    if (t.isIdentifier(mePath.node.object) && mePath.node.object.name === mapIdentifier.current!.name) {
                                        referencesMap = true;
                                        mePath.stop();
                                    }
                                },
                            });
                            if (referencesMap) decoderPath = innerPath as unknown as NodePath<any>;
                        }
                    },
                    VariableDeclarator(innerPath) {
                        const parentDecl = innerPath.parent as t.VariableDeclaration;
                        if (decoderVarDecl.match(parentDecl)) {
                            let referencesMap = false;
                            innerPath.traverse({
                                MemberExpression(mePath) {
                                    if (t.isIdentifier(mePath.node.object) && mePath.node.object.name === mapIdentifier.current!.name) {
                                        referencesMap = true;
                                        mePath.stop();
                                    }
                                },
                            });
                            if (referencesMap) decoderPath = innerPath as unknown as NodePath<any>;
                        }
                    },
                });
            }

            if (!decoderPath) return;

            // If we have a binding for the decoder name, rename it for easier later processing
            const decName = decoderName.current ? decoderName.current.name : null;
            let references: NodePath[] | null = null;
            if (decName) {
                const binding = path.scope.getBinding(decName);
                if (binding) {
                    renameFast(binding, '__ENCRYPTED_STRING_MAP_DECODER__');
                    references = binding.referencePaths;
                }
            }

            result = {
                path: decoderPath,
                references,
                name: '__ENCRYPTED_STRING_MAP_DECODER__',
                originalName: decName || '',
                mapName: mapIdentifier.current!.name,
                cacheName: foundCacheName,
            };

            path.stop();
        },
    });

    return result;
}
