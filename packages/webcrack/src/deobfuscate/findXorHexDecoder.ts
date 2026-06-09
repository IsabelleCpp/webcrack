import type { NodePath } from '@babel/traverse';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import debug from 'debug';
import { renameFast } from '../ast-utils';

export interface XorDecoderInfo {
    path: NodePath<t.Node>;
    references: NodePath[] | null;
    name: string;
    originalName: string;
    globalDeclPath: NodePath<t.VariableDeclaration> | null;
}

/**
 * Options:
 *  - enableLogging: false by default. Set true to enable debug output.
 */
export function findXorHexDecoder(
    ast: t.Node,
    opts?: { enableLogging?: boolean },
): XorDecoderInfo | undefined {
    const debugNamespace = 'webcrack:xor-hex-decoder-finder';
    const dbg = debug(debugNamespace);
    const loggingEnabled = !!opts?.enableLogging;

    // logger wrapper using apply to avoid TS spread tuple error and to match original style
    const logger = {
        log: (...args: unknown[]) => {
            if (loggingEnabled) (dbg as any).apply(undefined, args as any);
        },
        info: (...args: unknown[]) => {
            if (loggingEnabled) (dbg as any).apply(undefined, args as any);
        },
        enabled: loggingEnabled,
    };

    let result: XorDecoderInfo | undefined;

    function memberExpressionChainContainsIdentifier(node: t.Node | null, name: string): boolean {
        let cur: t.Node | null = node;
        while (cur) {
            if (t.isIdentifier(cur) && cur.name === name) return true;
            if (t.isMemberExpression(cur)) {
                cur = cur.object as t.Node | null;
                continue;
            }
            break;
        }
        return false;
    }

    function collectFunctionStructure(fnNode: t.Function | t.ArrowFunctionExpression) {
        const counts: Record<string, number> = {};
        const callTargets = new Map<string, number>();
        const memberSamples: string[] = [];
        const regexes: string[] = [];
        const numericLiterals: number[] = [];
        const stringLiterals: string[] = [];
        const identifiers: Map<string, number> = new Map();

        function inc(type: string) {
            counts[type] = (counts[type] || 0) + 1;
        }

        function recordCallTarget(name: string | null) {
            const key = name || '<unknown>';
            callTargets.set(key, (callTargets.get(key) || 0) + 1);
        }

        function sampleMember(me: t.MemberExpression) {
            const parts: string[] = [];
            let cur: t.Node | null = me as t.Node;
            let depth = 0;
            while (cur && t.isMemberExpression(cur) && depth < 6) {
                const prop = (cur as t.MemberExpression).property;
                if (t.isIdentifier(prop)) parts.unshift(prop.name);
                else if (t.isStringLiteral(prop)) parts.unshift(`'${prop.value}'`);
                else parts.unshift('[expr]');
                const obj = (cur as t.MemberExpression).object as t.Node;
                if (t.isIdentifier(obj)) {
                    parts.unshift(obj.name);
                    break;
                }
                cur = t.isMemberExpression(obj) ? obj : null;
                depth++;
            }
            memberSamples.push(parts.join('.'));
            if (memberSamples.length > 8) memberSamples.shift();
        }

        function walk(node: t.Node | null) {
            if (!node) return;
            inc(node.type);

            if (t.isCallExpression(node)) {
                const callee = node.callee;
                if (t.isIdentifier(callee)) {
                    recordCallTarget(callee.name);
                } else if (t.isMemberExpression(callee)) {
                    const prop = (callee as t.MemberExpression).property;
                    if (t.isIdentifier(prop)) recordCallTarget(prop.name);
                    else recordCallTarget('<member>');
                    sampleMember(callee as t.MemberExpression);
                } else {
                    recordCallTarget(null);
                }
            } else if (t.isMemberExpression(node)) {
                sampleMember(node);
            } else if (t.isRegExpLiteral(node)) {
                regexes.push(node.pattern);
            } else if (t.isNumericLiteral(node)) {
                numericLiterals.push(node.value);
            } else if (t.isStringLiteral(node)) {
                stringLiterals.push(node.value);
            } else if (t.isIdentifier(node)) {
                identifiers.set(node.name, (identifiers.get(node.name) || 0) + 1);
            }

            for (const key of Object.keys(node) as (keyof typeof node)[]) {
                const val = (node as any)[key];
                if (Array.isArray(val)) {
                    for (const child of val) {
                        if (child && typeof child.type === 'string') walk(child as t.Node);
                    }
                } else if (val && typeof val.type === 'string') {
                    walk(val as t.Node);
                }
            }
        }

        if (t.isBlockStatement(fnNode.body)) walk(fnNode.body);
        else walk(fnNode.body as t.Node);

        const topCalls = Array.from(callTargets.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([k, v]) => `${k}:${v}`);

        const topIds = Array.from(identifiers.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([k, v]) => `${k}:${v}`);

        return {
            counts,
            topCalls,
            memberSamples,
            regexes: regexes.slice(0, 6),
            numericLiterals: numericLiterals.slice(0, 6),
            stringLiterals: stringLiterals.slice(0, 6),
            topIdentifiers: topIds,
        };
    }

    function inspectFunctionNodeForXorSignals(fnNode: t.Function | t.ArrowFunctionExpression) {
        const flags = {
            hasSplit: false,
            hasMap: false,
            hasCharCodeAt: false,
            hasReduce: false,
            hasXorInReduce: false,
            hasParseIntHex: false,
            hasFromCharCode: false,
            hasJoin: false,
            paramCountTwo: false,
            hasSplitRegex: false,
            hasHexLiteralPairs: false,
        };

        // detect XOR operator inside a BinaryExpression used in reduce callback
        function detectXorInNode(node: t.Node | null) {
            if (!node) return;
            if (t.isBinaryExpression(node) && node.operator === '^') {
                flags.hasXorInReduce = true;
            }
            for (const key of Object.keys(node) as (keyof typeof node)[]) {
                const val = (node as any)[key];
                if (Array.isArray(val)) {
                    for (const child of val) {
                        if (child && typeof child.type === 'string') detectXorInNode(child as t.Node);
                    }
                } else if (val && typeof val.type === 'string') {
                    detectXorInNode(val as t.Node);
                }
            }
        }

        function walk(node: t.Node | null) {
            if (!node) return;

            if (t.isMemberExpression(node)) {
                const prop = (node as t.MemberExpression).property;
                if (t.isIdentifier(prop) && prop.name === 'split') flags.hasSplit = true;
                if (t.isIdentifier(prop) && prop.name === 'map') flags.hasMap = true;
                if (t.isIdentifier(prop) && prop.name === 'join') flags.hasJoin = true;
                if (t.isIdentifier(prop) && prop.name === 'charCodeAt') flags.hasCharCodeAt = true;
                if (t.isStringLiteral(prop) && prop.value === 'split') flags.hasSplit = true;
                walk((node as t.MemberExpression).object as t.Node);
                if ((node as t.MemberExpression).computed) walk((node as t.MemberExpression).property as t.Node);
                return;
            }

            if (t.isCallExpression(node)) {
                const callee = node.callee;
                // parseInt(..., 16)
                if (t.isIdentifier(callee) && callee.name === 'parseInt') {
                    if (node.arguments.length >= 2) {
                        const radix = node.arguments[1];
                        if (t.isNumericLiteral(radix) && radix.value === 16) flags.hasParseIntHex = true;
                    }
                }
                // String.fromCharCode
                if (t.isMemberExpression(callee)) {
                    const prop = (callee as t.MemberExpression).property;
                    const obj = (callee as t.MemberExpression).object;
                    if (t.isIdentifier(obj) && t.isIdentifier(prop) && obj.name === 'String' && prop.name === 'fromCharCode') {
                        flags.hasFromCharCode = true;
                    }
                }

                for (const arg of node.arguments) {
                    // stronger heuristic: looks like hex pairs e.g. "4f6b..." (no spaces)
                    if (t.isStringLiteral(arg) && /^(?:[0-9a-fA-F]{2})+$/.test(arg.value)) {
                        flags.hasHexLiteralPairs = true;
                    }
                    // detect split regex pattern /.{1,2}/g passed somewhere
                    if (t.isRegExpLiteral(arg) && arg.pattern === '.{1,2}') {
                        flags.hasSplitRegex = true;
                    }
                    walk(arg as t.Node);
                }

                if (t.isMemberExpression(callee)) {
                    walk((callee as t.MemberExpression).object as t.Node);
                    if ((callee as t.MemberExpression).computed) walk((callee as t.MemberExpression).property as t.Node);
                } else {
                    walk(callee as t.Node);
                }
                return;
            }

            if (t.isFunction(node) || t.isArrowFunctionExpression(node)) {
                // check param count for the top-level function only
                if (node === fnNode) {
                    flags.paramCountTwo = (node.params.length === 2);
                }
            }

            // detect XOR operator anywhere (used later to confirm reduce uses XOR)
            detectXorInNode(node);

            for (const key of Object.keys(node) as (keyof typeof node)[]) {
                const val = (node as any)[key];
                if (Array.isArray(val)) {
                    for (const child of val) {
                        if (child && typeof child.type === 'string') walk(child as t.Node);
                    }
                } else if (val && typeof val.type === 'string') {
                    walk(val as t.Node);
                }
            }
        }

        if (t.isBlockStatement(fnNode.body)) walk(fnNode.body);
        else walk(fnNode.body as t.Node);

        // Additional heuristic: ensure charCodeAt is used inside a map callback and reduce uses XOR
        function detectReduce(node: t.Node | null): boolean {
            if (!node) return false;
            if (t.isMemberExpression(node)) {
                const prop = (node as t.MemberExpression).property;
                if (t.isIdentifier(prop) && prop.name === 'reduce') return true;
                walkMember(node as t.MemberExpression);
            }
            for (const key of Object.keys(node) as (keyof typeof node)[]) {
                const val = (node as any)[key];
                if (Array.isArray(val)) {
                    for (const child of val) {
                        if (child && typeof child.type === 'string' && detectReduce(child as t.Node)) return true;
                    }
                } else if (val && typeof val.type === 'string' && detectReduce(val as t.Node)) return true;
            }
            return false;
        }
        function walkMember(me: t.MemberExpression | null) {
            if (!me) return;
            walk((me as any).object as t.Node);
            if ((me as any).computed) walk((me as any).property as t.Node);
        }

        const hasReduce = detectReduce(fnNode.body as t.Node);

        return {
            hasSplit: flags.hasSplit,
            hasMap: flags.hasMap,
            hasCharCodeAt: flags.hasCharCodeAt,
            hasReduce: hasReduce,
            hasXorInReduce: flags.hasXorInReduce,
            hasParseIntHex: flags.hasParseIntHex,
            hasFromCharCode: flags.hasFromCharCode,
            hasJoin: flags.hasJoin,
            paramCountTwo: flags.paramCountTwo,
            hasSplitRegex: flags.hasSplitRegex,
            hasHexLiteralPairs: flags.hasHexLiteralPairs,
        };
    }

    // traverse AST looking for functions with the XOR-hex pattern
    traverse(ast, {
        FunctionDeclaration(path) {
            if (result) {
                path.stop();
                return;
            }
            const fn = path.node;
            const signals = inspectFunctionNodeForXorSignals(fn);

            // log detailed signals for debugging parity with original file
            if (logger.enabled) {
                try {
                    (dbg as any).apply(undefined, ['function-declaration-signals', fn.id ? fn.id.name : '<anon>', JSON.stringify(signals)]);
                } catch {
                    logger.log('function-declaration-signals %s %o', fn.id ? fn.id.name : '<anon>', signals);
                }
            }

            const strong =
                signals.paramCountTwo &&
                signals.hasSplit &&
                signals.hasMap &&
                signals.hasCharCodeAt &&
                signals.hasReduce &&
                signals.hasXorInReduce &&
                signals.hasParseIntHex &&
                signals.hasFromCharCode &&
                signals.hasJoin;

            // allow borderline acceptance if hex-literal or split-regex present
            const borderline = signals.hasHexLiteralPairs || signals.hasSplitRegex;
            if (strong || (signals.hasParseIntHex && signals.hasXorInReduce && borderline)) {
                const name = fn.id ? fn.id.name : '__anon__';
                let references: NodePath[] | null = null;
                try {
                    const binding = name ? path.scope.getBinding(name) : null;
                    if (binding) {
                        try {
                            renameFast(binding, '__XOR_DECODER__');
                            logger.log('renamed decoder binding %s -> __XOR_DECODER__', name);
                        } catch (e) {
                            logger.log('failed to rename binding %s: %s', name, (e as Error).message);
                        }
                        references = binding.referencePaths || null;
                    }
                } catch (e) {
                    logger.log('binding lookup/rename error for %s: %s', name, (e as Error).message);
                }

                // collect structure and log it compactly
                try {
                    const structure = collectFunctionStructure(fn);
                    if (logger.enabled) {
                        try {
                            (dbg as any).apply(undefined, ['decoder-structure', name, JSON.stringify(structure, null, 2)]);
                        } catch {
                            logger.log('decoder structure (compact) %s %o', name, structure);
                        }
                    }
                } catch (e) {
                    logger.log('failed to collect structure for %s: %s', name, (e as Error).message);
                }

                logger.log('xor-hex-decoder candidate found: %s signals=%o borderline=%s', name, {
                    paramCountTwo: signals.paramCountTwo,
                    split: signals.hasSplit,
                    map: signals.hasMap,
                    charCodeAt: signals.hasCharCodeAt,
                    reduce: signals.hasReduce,
                    xor: signals.hasXorInReduce,
                    parseIntHex: signals.hasParseIntHex,
                    fromCharCode: signals.hasFromCharCode,
                    join: signals.hasJoin,
                    splitRegex: signals.hasSplitRegex,
                    hexLiteralPairs: signals.hasHexLiteralPairs,
                }, String(borderline));

                result = {
                    path,
                    references,
                    name: '__XOR_DECODER__',
                    originalName: name,
                    globalDeclPath: null,
                };
                path.stop();
            } else if (logger.enabled) {
                // verbose rejection logging for functions that reference likely patterns but miss strong signals
                if (signals.hasParseIntHex || signals.hasXorInReduce || signals.hasFromCharCode) {
                    const missing: string[] = [];
                    if (!signals.hasSplit && !signals.hasMap && !signals.hasCharCodeAt) missing.push('split|map|charCodeAt');
                    if (!signals.hasReduce || !signals.hasXorInReduce) missing.push('reduce|xor');
                    if (!signals.hasParseIntHex && !signals.hasFromCharCode) missing.push('parseIntHex|fromCharCode');
                    logger.log('function referencing hex-like operations rejected (no strong signal): name=%s signals=%o missing=%s', fn.id ? fn.id.name : '<anon>', signals, missing.join(', '));
                }
            }
        },

        VariableDeclarator(path) {
            if (result) {
                path.stop();
                return;
            }
            if (!t.isIdentifier(path.node.id)) return;
            const init = path.node.init;
            if (!init || (!t.isFunctionExpression(init) && !t.isArrowFunctionExpression(init))) return;

            const signals = inspectFunctionNodeForXorSignals(init as any);

            if (logger.enabled) {
                try {
                    (dbg as any).apply(undefined, ['variable-declarator-signals', path.node.id.name, JSON.stringify(signals)]);
                } catch {
                    logger.log('variable-declarator-signals %s %o', path.node.id.name, signals);
                }
            }

            const strong =
                signals.paramCountTwo &&
                signals.hasSplit &&
                signals.hasMap &&
                signals.hasCharCodeAt &&
                signals.hasReduce &&
                signals.hasXorInReduce &&
                signals.hasParseIntHex &&
                signals.hasFromCharCode &&
                signals.hasJoin;

            const borderline = signals.hasHexLiteralPairs || signals.hasSplitRegex;
            if (strong || (signals.hasParseIntHex && signals.hasXorInReduce && borderline)) {
                const name = path.node.id.name;
                let references: NodePath[] | null = null;
                try {
                    const binding = path.scope.getBinding(name);
                    if (binding) {
                        try {
                            renameFast(binding, '__XOR_DECODER__');
                            logger.log('renamed decoder binding %s -> __XOR_DECODER__', name);
                        } catch (e) {
                            logger.log('failed to rename binding %s: %s', name, (e as Error).message);
                        }
                        references = binding.referencePaths || null;
                    }
                } catch (e) {
                    logger.log('binding lookup/rename error for %s: %s', name, (e as Error).message);
                }

                try {
                    const structure = collectFunctionStructure(init as any);
                    if (logger.enabled) {
                        try {
                            (dbg as any).apply(undefined, ['decoder-structure', name, JSON.stringify(structure, null, 2)]);
                        } catch {
                            logger.log('decoder structure (compact) %s %o', name, structure);
                        }
                    }
                } catch (e) {
                    logger.log('failed to collect structure for %s: %s', name, (e as Error).message);
                }

                logger.log('xor-hex-decoder candidate found (var): %s signals=%o borderline=%s', name, {
                    paramCountTwo: signals.paramCountTwo,
                    split: signals.hasSplit,
                    map: signals.hasMap,
                    charCodeAt: signals.hasCharCodeAt,
                    reduce: signals.hasReduce,
                    xor: signals.hasXorInReduce,
                    parseIntHex: signals.hasParseIntHex,
                    fromCharCode: signals.hasFromCharCode,
                    join: signals.hasJoin,
                    splitRegex: signals.hasSplitRegex,
                    hexLiteralPairs: signals.hasHexLiteralPairs,
                }, String(borderline));

                result = {
                    path,
                    references,
                    name: '__XOR_DECODER__',
                    originalName: name,
                    globalDeclPath: null,
                };
                path.stop();
            } else if (logger.enabled) {
                if (signals.hasParseIntHex || signals.hasXorInReduce || signals.hasFromCharCode) {
                    const missing: string[] = [];
                    if (!signals.hasSplit && !signals.hasMap && !signals.hasCharCodeAt) missing.push('split|map|charCodeAt');
                    if (!signals.hasReduce || !signals.hasXorInReduce) missing.push('reduce|xor');
                    if (!signals.hasParseIntHex && !signals.hasFromCharCode) missing.push('parseIntHex|fromCharCode');
                    logger.log('variable declarator referencing hex-like operations rejected (no strong signal): name=%s signals=%o missing=%s', path.node.id.name, signals, missing.join(', '));
                }
            }
        },

        AssignmentExpression(path) {
            if (result) {
                path.stop();
                return;
            }
            if (!t.isIdentifier(path.node.left)) return;
            const right = path.node.right;
            if (!t.isFunctionExpression(right) && !t.isArrowFunctionExpression(right)) return;

            const signals = inspectFunctionNodeForXorSignals(right);

            if (logger.enabled) {
                try {
                    (dbg as any).apply(undefined, ['assignment-expression-signals', (path.node.left as t.Identifier).name, JSON.stringify(signals)]);
                } catch {
                    logger.log('assignment-expression-signals %s %o', (path.node.left as t.Identifier).name, signals);
                }
            }

            const strong =
                signals.paramCountTwo &&
                signals.hasSplit &&
                signals.hasMap &&
                signals.hasCharCodeAt &&
                signals.hasReduce &&
                signals.hasXorInReduce &&
                signals.hasParseIntHex &&
                signals.hasFromCharCode &&
                signals.hasJoin;

            const borderline = signals.hasHexLiteralPairs || signals.hasSplitRegex;
            if (strong || (signals.hasParseIntHex && signals.hasXorInReduce && borderline)) {
                const name = (path.node.left as t.Identifier).name;
                let references: NodePath[] | null = null;
                try {
                    const binding = path.scope.getBinding(name);
                    if (binding) {
                        try {
                            renameFast(binding, '__XOR_DECODER__');
                            logger.log('renamed decoder binding %s -> __XOR_DECODER__', name);
                        } catch (e) {
                            logger.log('failed to rename binding %s: %s', name, (e as Error).message);
                        }
                        references = binding.referencePaths || null;
                    }
                } catch (e) {
                    logger.log('binding lookup/rename error for %s: %s', name, (e as Error).message);
                }

                try {
                    const structure = collectFunctionStructure(right);
                    if (logger.enabled) {
                        try {
                            (dbg as any).apply(undefined, ['decoder-structure', name, JSON.stringify(structure, null, 2)]);
                        } catch {
                            logger.log('decoder structure (compact) %s %o', name, structure);
                        }
                    }
                } catch (e) {
                    logger.log('failed to collect structure for %s: %s', name, (e as Error).message);
                }

                logger.log('xor-hex-decoder candidate found (assign): %s signals=%o borderline=%s', name, {
                    paramCountTwo: signals.paramCountTwo,
                    split: signals.hasSplit,
                    map: signals.hasMap,
                    charCodeAt: signals.hasCharCodeAt,
                    reduce: signals.hasReduce,
                    xor: signals.hasXorInReduce,
                    parseIntHex: signals.hasParseIntHex,
                    fromCharCode: signals.hasFromCharCode,
                    join: signals.hasJoin,
                    splitRegex: signals.hasSplitRegex,
                    hexLiteralPairs: signals.hasHexLiteralPairs,
                }, String(borderline));

                result = {
                    path,
                    references,
                    name: '__XOR_DECODER__',
                    originalName: name,
                    globalDeclPath: null,
                };
                path.stop();
            } else if (logger.enabled) {
                if (signals.hasParseIntHex || signals.hasXorInReduce || signals.hasFromCharCode) {
                    const missing: string[] = [];
                    if (!signals.hasSplit && !signals.hasMap && !signals.hasCharCodeAt) missing.push('split|map|charCodeAt');
                    if (!signals.hasReduce || !signals.hasXorInReduce) missing.push('reduce|xor');
                    if (!signals.hasParseIntHex && !signals.hasFromCharCode) missing.push('parseIntHex|fromCharCode');
                    logger.log('assignment referencing hex-like operations rejected (no strong signal): name=%s signals=%o missing=%s', (path.node.left as t.Identifier).name, signals, missing.join(', '));
                }
            }
        },
    });

    if (!result && logger.enabled) logger.log('no xor hex decoder found');
    return result;
}
