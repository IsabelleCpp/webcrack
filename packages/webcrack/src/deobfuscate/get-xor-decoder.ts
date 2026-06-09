// get-xor-decoder.ts
import { expression } from '@babel/template';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import debug from 'debug';
import {
    inlineVariable
} from '../ast-utils';
import type { XorDecoderInfo } from './findXorHexDecoder';
const debugNamespace = 'webcrack:get-xor-decoder';
const dbg = debug(debugNamespace);

/**
 * Decoder wrapper for the xor-hex decoder discovered by findXorHexDecoder.
 */
export class XorDecoderObject {
    originalName: string;
    name: string;
    path: NodePath<t.FunctionDeclaration>;

    constructor(
        originalName: string,
        name: string,
        path: NodePath<t.FunctionDeclaration>,
    ) {
        this.originalName = originalName;
        this.name = name;
        this.path = path;
    }

    /**
     * Collect call sites for this decoder
     *
     * Behavior:
     * - Handle direct references to the decoder identifier (existing behavior).
     * - Detect the object property that contains the module function where the decoder is exported.
     * - Inspect that module function to find the export key that returns the decoder identifier.
     * - Find variables assigned from resolver calls that reference that module.
     * - Replace occurrences of Object(var.<exportKey>) or Object(resolver(...).<exportKey>) with the decoder identifier
     *   so indirect usages become direct calls and can be matched/inlined.
     */
    collectCalls(): NodePath<t.CallExpression>[] {
        // capture instance fields into locals so nested callbacks don't reference `this`
        const origName = this.originalName;
        const localName = this.name;
        const funcPath = this.path;

        const calls: NodePath<t.CallExpression>[] = [];

        // matcher for direct literal calls to the decoder (keeps existing behavior)
        const literalArgument: m.Matcher<t.Expression> = m.or(
            m.binaryExpression(
                m.anything(),
                m.matcher((node) => literalArgument.match(node)),
                m.matcher((node) => literalArgument.match(node)),
            ),
            m.unaryExpression('-', m.matcher((node) => literalArgument.match(node))),
            m.numericLiteral(),
            m.stringLiteral(),
        );
        const literalCall = m.callExpression(m.identifier(localName), m.arrayOf(literalArgument));
        const expressionCall = m.callExpression(m.identifier(localName), m.arrayOf(m.anyExpression()));
        const conditional = m.capture(m.conditionalExpression());
        const conditionalCall = m.callExpression(m.identifier(localName), [conditional]);
        const buildExtractedConditional = expression`TEST ? CALLEE(CONSEQUENT) : CALLEE(ALTERNATE)`;

        // 0) Handle direct references to the decoder identifier (existing behavior)
        const binding =
            (funcPath.scope.getBinding(localName) || funcPath.scope.getProgramParent().getBinding(localName)) ?? null;
        if (binding) {
            for (const ref of binding.referencePaths) {
                if (!ref.parentPath) continue;

                if (conditionalCall.match(ref.parent)) {
                    const [replacement] = ref.parentPath!.replaceWith(
                        buildExtractedConditional({
                            TEST: conditional.current!.test,
                            CALLEE: ref.parent.callee,
                            CONSEQUENT: conditional.current!.consequent,
                            ALTERNATE: conditional.current!.alternate,
                        }),
                    );
                    replacement.scope.crawl();
                    continue;
                }

                if (literalCall.match(ref.parent)) {
                    calls.push(ref.parentPath as NodePath<t.CallExpression>);
                    continue;
                }

                if (expressionCall.match(ref.parent)) {
                    ref.parentPath!.traverse({
                        ReferencedIdentifier(path) {
                            const varBinding = path.scope.getBinding(path.node.name);
                            if (!varBinding) return;
                            inlineVariable(varBinding, literalArgument, true);
                        },
                    });
                    if (literalCall.match(ref.parent)) {
                        calls.push(ref.parentPath as NodePath<t.CallExpression>);
                    }
                    continue;
                }

                if (ref.parentPath?.isExpressionStatement()) {
                    ref.parentPath.remove();
                }
            }
        }

        //
        // Module-based detection (focused)
        // Steps:
        // 1) Find the object property that contains the module function where the decoder is defined.
        // 2) Inspect that module function body to find the export key that returns the decoder identifier.
        // 3) Find variables assigned from resolver calls that reference that module.
        // 4) Replace occurrences of Object(var.<exportKey>) or Object(resolver(...).<exportKey>) with the decoder identifier.
        //
        const programPath = funcPath.scope.getProgramParent().path;

        // 1) Extract enclosing module property and its key
        let moduleKeyFromEnclosing: string | null = null;
        let modulePropertyPath: NodePath<any> | null = null;
        {
            const visited = new WeakSet<t.Node>();
            let cur: NodePath<any> | null = funcPath as NodePath<any>;
            let steps = 0;
            const MAX_STEPS = 200;
            while (cur && steps < MAX_STEPS) {
                steps++;
                const parent = cur.parentPath as NodePath<any> | null;
                if (!parent) break;
                if (visited.has(parent.node)) break;
                visited.add(parent.node);

                if (parent.isObjectProperty() || parent.isObjectMethod() || parent.isProperty()) {
                    const key = (parent.node as any).key as t.Node | null;
                    if (key) {
                        if (t.isStringLiteral(key)) {
                            moduleKeyFromEnclosing = key.value;
                            modulePropertyPath = parent;
                            break;
                        }
                        if (t.isNumericLiteral(key)) {
                            moduleKeyFromEnclosing = String(key.value);
                            modulePropertyPath = parent;
                            break;
                        }
                        if (t.isIdentifier(key)) {
                            moduleKeyFromEnclosing = key.name;
                            modulePropertyPath = parent;
                            break;
                        }
                    }
                }

                if (parent.isObjectExpression()) {
                    for (const prop of parent.node.properties) {
                        if (t.isObjectProperty(prop) || t.isObjectMethod(prop)) {
                            const val = (prop as t.ObjectProperty).value ?? null;
                            if (
                                val === cur.node ||
                                (t.isFunctionExpression(val) &&
                                    (t.isFunctionDeclaration(cur.node) || t.isFunctionExpression(cur.node)) &&
                                    val.body === (cur.node as any).body)
                            ) {
                                const key = prop.key;
                                if (t.isStringLiteral(key)) {
                                    moduleKeyFromEnclosing = key.value;
                                    modulePropertyPath = parent.get('properties').find((p: any) => p.node === prop) as NodePath<any>;
                                    break;
                                }
                                if (t.isNumericLiteral(key)) {
                                    moduleKeyFromEnclosing = String(key.value);
                                    modulePropertyPath = parent.get('properties').find((p: any) => p.node === prop) as NodePath<any>;
                                    break;
                                }
                                if (t.isIdentifier(key)) {
                                    moduleKeyFromEnclosing = key.name;
                                    modulePropertyPath = parent.get('properties').find((p: any) => p.node === prop) as NodePath<any>;
                                    break;
                                }
                            }
                        }
                    }
                    if (moduleKeyFromEnclosing) break;
                }

                cur = parent;
            }
        }

        if (!moduleKeyFromEnclosing || !modulePropertyPath) {
            return calls;
        }

        // 2) Inspect module function body to find the export key that returns our decoder identifier
        let exportKeyForModule: string | null = null;
        const moduleValuePath = (() => {
            try {
                if (modulePropertyPath!.isObjectProperty() || modulePropertyPath!.isProperty()) {
                    const maybe = modulePropertyPath!.get('value') as NodePath<any> | undefined;
                    if (maybe && maybe.node) return maybe;
                }
            } catch (e) {
                // fallback
            }
            return modulePropertyPath!;
        })();

        if (moduleValuePath) {
            moduleValuePath.traverse({
                CallExpression(callPath) {
                    const node = callPath.node;
                    if (!t.isMemberExpression(node.callee)) return;
                    const maybeFnArg = node.arguments.find((a) => t.isFunctionExpression(a) || t.isArrowFunctionExpression(a));
                    if (!maybeFnArg) return;
                    const maybeKey = node.arguments[1];
                    if (!maybeKey) return;
                    let returnedId: string | null = null;
                    const fn = maybeFnArg as t.FunctionExpression | t.ArrowFunctionExpression;
                    if (t.isBlockStatement(fn.body)) {
                        for (const stmt of fn.body.body) {
                            if (t.isReturnStatement(stmt) && t.isIdentifier(stmt.argument)) {
                                returnedId = stmt.argument.name;
                                break;
                            }
                        }
                    } else if (t.isIdentifier(fn.body)) {
                        returnedId = fn.body.name;
                    }
                    if (!returnedId) return;
                    if (returnedId !== localName && returnedId !== origName) return;

                    exportKeyForModule = t.isStringLiteral(maybeKey) ? maybeKey.value : (t.isIdentifier(maybeKey) ? maybeKey.name : null);
                    callPath.stop();
                },
            });
        }

        if (!exportKeyForModule) {
            return calls;
        }

        // 3) Find variables assigned from resolver-like calls that reference the same module key
        const varToModule = new Map<string, { moduleKey: string }>();
        programPath.traverse({
            VariableDeclarator(varPath) {
                const init = varPath.node.init;
                if (!init || !t.isCallExpression(init)) return;
                if (init.arguments.length !== 1) return;
                const arg0 = init.arguments[0];
                if (!t.isStringLiteral(arg0)) return;
                const foundModuleKey = arg0.value;
                if (foundModuleKey !== moduleKeyFromEnclosing) return;
                if (t.isIdentifier(varPath.node.id)) {
                    varToModule.set(varPath.node.id.name, { moduleKey: foundModuleKey });
                }
            },
            AssignmentExpression(assignPath) {
                const right = assignPath.node.right;
                if (!t.isCallExpression(right)) return;
                if (right.arguments.length !== 1) return;
                const arg0 = right.arguments[0];
                if (!t.isStringLiteral(arg0)) return;
                const foundModuleKey = arg0.value;
                if (foundModuleKey !== moduleKeyFromEnclosing) return;
                const left = assignPath.node.left;
                if (t.isIdentifier(left)) {
                    varToModule.set(left.name, { moduleKey: foundModuleKey });
                }
            },
        });

        // helper: loose member match for <anyResolver>(moduleKey).<exportKey> or <var>.<exportKey>
        function memberMatchesLoose(node: t.Node, exportKey: string, moduleKey: string): boolean {
            if (!t.isMemberExpression(node)) return false;
            const obj = node.object;
            const prop = node.property;

            // direct call object: <anyResolver>(moduleKey).<exportKey>
            if (
                t.isCallExpression(obj) &&
                obj.arguments.length === 1 &&
                t.isStringLiteral(obj.arguments[0]) &&
                obj.arguments[0].value === moduleKey
            ) {
                if (t.isIdentifier(prop) && prop.name === exportKey) return true;
                if (t.isStringLiteral(prop) && prop.value === exportKey) return true;
            }

            // variable initialized from resolver(moduleKey): <var>.<exportKey>
            if (t.isIdentifier(obj)) {
                const mapped = varToModule.get(obj.name);
                if (mapped && mapped.moduleKey === moduleKey) {
                    if (t.isIdentifier(prop) && prop.name === exportKey) return true;
                    if (t.isStringLiteral(prop) && prop.value === exportKey) return true;
                }
            }

            return false;
        }

        // 4) Replace Object(var.a) or Object(resolver(...).a) with the decoder identifier
        programPath.traverse({
            CallExpression(callPath) {
                const node = callPath.node;

                // case A: callee is a CallExpression like Object(var.a) used as callee: Object(var.a)(...)
                if (t.isCallExpression(node.callee) && t.isIdentifier(node.callee.callee) && node.callee.callee.name === 'Object') {
                    const firstArg = node.callee.arguments[0];
                    if (firstArg && memberMatchesLoose(firstArg as t.Node, exportKeyForModule!, moduleKeyFromEnclosing)) {
                        try {
                            const innerPath = callPath.get('callee') as NodePath<any>;
                            innerPath.replaceWith(t.identifier(localName));
                            callPath.scope.crawl();
                        } catch (e) {
                            // ignore replacement errors
                        }
                        calls.push(callPath as NodePath<t.CallExpression>);
                        return;
                    }
                }

                // case B: an argument is a CallExpression like Object(var.a) passed as argument
                for (let ai = 0; ai < node.arguments.length; ai++) {
                    const arg = node.arguments[ai];
                    if (t.isCallExpression(arg) && t.isIdentifier(arg.callee) && arg.callee.name === 'Object') {
                        const firstArg = arg.arguments[0];
                        if (firstArg && memberMatchesLoose(firstArg as t.Node, exportKeyForModule!, moduleKeyFromEnclosing)) {
                            try {
                                const argPath = callPath.get('arguments.' + String(ai)) as NodePath<any>;
                                argPath.replaceWith(t.identifier(localName));
                                callPath.scope.crawl();
                            } catch (e) {
                                // ignore replacement errors
                            }
                            calls.push(callPath as NodePath<t.CallExpression>);
                            return;
                        }
                    }
                }
            },
        });

        return calls;
    }
}

/**
 * Build an XorDecoderObject from the info returned by findXorHexDecoder.
 */
export function getDecoderForXor(info: XorDecoderInfo): XorDecoderObject {
    let fnPath = info.path as NodePath<any>;

    const functionPath = fnPath as NodePath<t.FunctionDeclaration>;

    return new XorDecoderObject(info.originalName, info.name, functionPath);
}
