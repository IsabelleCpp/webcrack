import type { NodePath } from '@babel/traverse';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import debug from 'debug';
import { renameFast } from '../ast-utils';

export interface EncryptedStringMap {
    /** path to the decoder assignment or variable declarator */
    path: NodePath<t.Node>;
    /** reference paths for the decoder binding, if available */
    references: NodePath[] | null;
    /** canonical name used by transforms */
    name: string;
    /** original identifier name found in source */
    originalName: string;
    /** original map identifier name found in source */
    mapName: string;
    /** path to the map declaration (VariableDeclaration NodePath) */
    mapPath: NodePath<t.VariableDeclaration> | null;
    /** original cache identifier name (if detected) */
    cacheName: string | null;
    /** path to the cache declaration (VariableDeclaration NodePath) */
    cachePath: NodePath<t.VariableDeclaration> | null;
}

/**
 * Options:
 *  - enableLogging: false by default. Set true to enable debug output.
 */
export function findEncryptedStringMap(
    ast: t.Node,
    opts?: { enableLogging?: boolean },
): EncryptedStringMap | undefined {
    const debugNamespace = 'webcrack:hex-xor-keyed-map-finder';
    const dbg = debug(debugNamespace);
    const loggingEnabled = !!opts?.enableLogging;

    // logger wrapper using apply to avoid TS spread tuple error
    const logger = {
        log: (...args: unknown[]) => {
            if (loggingEnabled) (dbg as any).apply(undefined, args as any);
        },
        info: (...args: unknown[]) => {
            if (loggingEnabled) (dbg as any).apply(undefined, args as any);
        },
        enabled: loggingEnabled,
    };

    let result: EncryptedStringMap | undefined;
    const insertedGlobalBindings = new Set<string>();

    /* ---------- helpers ---------- */

    function inspectMapObject(obj: t.ObjectExpression) {
        for (const prop of obj.properties) {
            if (!t.isObjectProperty(prop) || !t.isObjectExpression(prop.value)) continue;
            for (const inner of prop.value.properties) {
                if (t.isObjectProperty(inner) && t.isStringLiteral(inner.value)) {
                    const outerKey = t.isIdentifier(prop.key) ? prop.key.name : '<non-id>';
                    const innerKey = t.isIdentifier(inner.key) ? inner.key.name : '<non-id>';
                    return { outerKey, innerKey, value: inner.value.value };
                }
            }
        }
        return null;
    }

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

    // Improved detector: recognizes string-literal property access, computed properties,
    // method names passed as strings, Buffer.from, String.fromCharCode, parseInt, atob, etc.
    function inspectFunctionNodeForDecoderSignalsLocal(fnNode: t.Function | t.ArrowFunctionExpression, mapName: string) {
        const flags = {
            hasMatch: false,
            hasSplit: false,
            hasReplace: false,
            hasJoin: false,
            hasMap: false,
            hasParseInt: false,
            hasReduce: false,
            hasFromCharCode: false,
            hasBufferFrom: false,
            hasAtob: false,
            hasArrayFrom: false,
            hasRegexInCall: false,
            referencesMap: false,
        };

        function markByPropName(propName: string | null) {
            if (!propName) return;
            if (propName === 'match') flags.hasMatch = true;
            if (propName === 'split') flags.hasSplit = true;
            if (propName === 'replace') flags.hasReplace = true;
            if (propName === 'join') flags.hasJoin = true;
            if (propName === 'map') flags.hasMap = true;
            if (propName === 'reduce') flags.hasReduce = true;
            if (propName === 'fromCharCode') flags.hasFromCharCode = true;
            if (propName === 'charCodeAt') flags.hasFromCharCode = true;
        }

        function walk(node: t.Node | null) {
            if (!node) return;

            if (t.isMemberExpression(node)) {
                const prop = (node as t.MemberExpression).property;
                if (t.isIdentifier(prop)) markByPropName(prop.name);
                if (t.isStringLiteral(prop)) markByPropName(prop.value);

                if (memberExpressionChainContainsIdentifier((node as t.MemberExpression).object as t.Node, mapName)) flags.referencesMap = true;

                walk((node as t.MemberExpression).object as t.Node);
                if ((node as t.MemberExpression).computed) walk((node as t.MemberExpression).property as t.Node);
                return;
            }

            if (t.isCallExpression(node)) {
                const callee = node.callee;

                if (t.isMemberExpression(callee)) {
                    const prop = (callee as t.MemberExpression).property;
                    if (t.isIdentifier(prop)) markByPropName(prop.name);
                    if (t.isStringLiteral(prop)) markByPropName(prop.value);

                    const calleeObj = (callee as t.MemberExpression).object;
                    if (t.isIdentifier(calleeObj) && t.isIdentifier(prop)) {
                        if (calleeObj.name === 'Buffer' && prop.name === 'from') flags.hasBufferFrom = true;
                        if (calleeObj.name === 'String' && prop.name === 'fromCharCode') flags.hasFromCharCode = true;
                    }

                    if (memberExpressionChainContainsIdentifier((callee as t.MemberExpression).object as t.Node, mapName)) flags.referencesMap = true;

                    walk((callee as t.MemberExpression).object as t.Node);
                    if ((callee as t.MemberExpression).computed) walk((callee as t.MemberExpression).property as t.Node);
                } else if (t.isIdentifier(callee)) {
                    if (callee.name === 'parseInt') {
                        flags.hasParseInt = true;
                        if (node.arguments.length >= 2) {
                            const radix = node.arguments[1];
                            if (t.isNumericLiteral(radix) && radix.value === 16) flags.hasParseInt = true;
                        }
                    }
                    if (callee.name === 'atob') flags.hasAtob = true;
                    if (callee.name === 'Array' || callee.name === 'Array.from') flags.hasArrayFrom = true;
                }

                for (const arg of node.arguments) {
                    if (t.isRegExpLiteral(arg)) flags.hasRegexInCall = true;
                    if (t.isStringLiteral(arg)) markByPropName(arg.value);
                    if (t.isArrayExpression(arg)) {
                        for (const el of arg.elements) {
                            if (t.isStringLiteral(el)) markByPropName(el.value);
                        }
                    }
                    walk(arg as t.Node);
                }
                return;
            }

            if (t.isIdentifier(node)) {
                if (node.name === mapName) flags.referencesMap = true;
                if (node.name === 'Array' || node.name === 'Array.from') flags.hasArrayFrom = true;
                return;
            }

            if (t.isStringLiteral(node)) {
                markByPropName(node.value);
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

        return flags;
    }

    function ensureGlobalBindingAtProgramTop(decoderIdName: string, anyDeclPath: NodePath<t.VariableDeclaration>) {
        try {
            if (insertedGlobalBindings.has(decoderIdName)) return;

            const programPath = anyDeclPath.scope.getProgramParent().path;
            if (!programPath || !programPath.node || !Array.isArray((programPath.node as any).body)) return;

            const body = (programPath.node as any).body as t.Statement[];
            for (const stmt of body) {
                if (!t.isVariableDeclaration(stmt)) continue;
                for (const d of stmt.declarations) {
                    if (t.isIdentifier(d.id) && d.id.name === decoderIdName) {
                        insertedGlobalBindings.add(decoderIdName);
                        if (programPath && typeof (programPath as any).scope?.crawl === 'function') (programPath as any).scope.crawl();
                        return;
                    }
                }
            }

            const varDecl = t.variableDeclaration('var', [
                t.variableDeclarator(t.identifier(decoderIdName), t.nullLiteral()),
            ]);

            let insertIndex = 0;
            for (let i = 0; i < body.length; i++) {
                const s = body[i];
                if (t.isExpressionStatement(s) && t.isStringLiteral(s.expression)) {
                    insertIndex = i + 1;
                    continue;
                }
                break;
            }

            try {
                if (typeof (programPath as any).unshiftContainer === 'function' && insertIndex === 0) {
                    (programPath as any).unshiftContainer('body', varDecl);
                } else {
                    (programPath.node as any).body.splice(insertIndex, 0, varDecl);
                }
            } catch {
                (programPath.node as any).body.splice(insertIndex, 0, varDecl);
            }

            if (programPath && typeof (programPath as any).scope?.crawl === 'function') {
                (programPath as any).scope.crawl();
            } else if (anyDeclPath && typeof anyDeclPath.scope.crawl === 'function') {
                anyDeclPath.scope.crawl();
            }

            insertedGlobalBindings.add(decoderIdName);
            logger.log('inserted global var %s = null; at program top (index=%d) and crawled scopes', decoderIdName, insertIndex);
        } catch (e) {
            logger.log('failed to insert global var %s = null;: %s', decoderIdName, (e as Error).message);
        }
    }

    /* ---------- collect map candidates ---------- */

    const mapCandidates: {
        name: string;
        node: t.VariableDeclarator;
        nested?: { outerKey: string; innerKey: string; value: string };
        declPath: NodePath<t.VariableDeclaration>;
    }[] = [];

    traverse(ast, {
        VariableDeclaration(path) {
            for (const decl of path.node.declarations) {
                if (!t.isIdentifier(decl.id) || !decl.init || !t.isObjectExpression(decl.init)) continue;
                const mapInfo = inspectMapObject(decl.init);
                if (mapInfo) {
                    mapCandidates.push({
                        name: decl.id.name,
                        node: decl,
                        nested: mapInfo,
                        declPath: path,
                    });
                    logger.log('candidate map found: %s (example %s.%s = "%s...")', decl.id.name, mapInfo.outerKey, mapInfo.innerKey, mapInfo.value.slice(0, 24));
                }
            }
        },
    });

    if (mapCandidates.length === 0) {
        logger.log('no map candidates found');
        return undefined;
    }

    const candidatesToTry = mapCandidates;

    for (const candidate of candidatesToTry) {
        const mapName = candidate.name;
        let foundCacheName: string | null = null;
        let cacheDeclPath: NodePath<t.VariableDeclaration> | null = null;
        let decoderPath: NodePath<any> | null = null;
        let decoderIdName: string | null = null;

        // detect immediate cache declaration (empty object) after map
        try {
            const parentPath = candidate.declPath.parentPath;
            if (parentPath && parentPath.node && Array.isArray((parentPath.node as any).body)) {
                const body = (parentPath.node as any).body as t.Statement[];
                const declNode = candidate.declPath.node;
                const idx = body.indexOf(declNode);
                if (idx >= 0 && idx + 1 < body.length) {
                    const nextStmt = body[idx + 1];
                    if (t.isVariableDeclaration(nextStmt)) {
                        for (const d of nextStmt.declarations) {
                            if (t.isIdentifier(d.id) && d.init && t.isObjectExpression(d.init) && d.init.properties.length === 0) {
                                foundCacheName = d.id.name;
                                const nextPath = candidate.declPath.getSibling(idx + 1) as NodePath<t.VariableDeclaration> | undefined;
                                if (nextPath && nextPath.isVariableDeclaration()) cacheDeclPath = nextPath;
                                break;
                            }
                        }
                    }
                }
            }
        } catch (e) {
            logger.log('cache detection error for map %s: %s', mapName, (e as Error).message);
        }

        logger.log('map %s: cache candidate=%s', mapName, String(foundCacheName));

        let found = false;

        traverse(ast, {
            AssignmentExpression(path) {
                if (found) {
                    path.stop();
                    return;
                }
                if (!t.isIdentifier(path.node.left)) return;
                const right = path.node.right;
                if (!t.isFunctionExpression(right) && !t.isArrowFunctionExpression(right)) return;

                const flags = inspectFunctionNodeForDecoderSignalsLocal(right, mapName);

                const hasStrongSignal =
                    flags.hasParseInt ||
                    flags.hasFromCharCode ||
                    flags.hasBufferFrom ||
                    flags.hasAtob ||
                    flags.hasArrayFrom ||
                    flags.hasRegexInCall ||
                    flags.hasMap ||
                    flags.hasReduce ||
                    flags.hasJoin ||
                    flags.hasMatch ||
                    flags.hasSplit ||
                    flags.hasReplace;

                if (flags.referencesMap && hasStrongSignal) {
                    decoderPath = path;
                    decoderIdName = path.node.left.name;
                    found = true;

                    const structure = collectFunctionStructure(right);
                    try {
                        if (loggingEnabled) {
                            (dbg as any).apply(undefined, ['decoder-structure', decoderIdName, JSON.stringify(structure, null, 2)]);
                        }
                    } catch {
                        logger.log('decoder structure (compact) %s %o', decoderIdName, structure);
                    }

                    logger.log(
                        'decoder assignment candidate found (relaxed): %s signals=%o referencesMap=%s',
                        decoderIdName,
                        {
                            parseInt: flags.hasParseInt,
                            fromCharCode: flags.hasFromCharCode,
                            bufferFrom: flags.hasBufferFrom,
                            atob: flags.hasAtob,
                            arrayFrom: flags.hasArrayFrom,
                            regex: flags.hasRegexInCall,
                            map: flags.hasMap,
                            reduce: flags.hasReduce,
                            join: flags.hasJoin,
                            match: flags.hasMatch,
                            split: flags.hasSplit,
                            replace: flags.hasReplace,
                        },
                        flags.referencesMap,
                    );

                    // ensure global binding for decoder if needed and attempt rename
                    try {
                        let binding = path.scope.getBinding(decoderIdName);
                        if (!binding) {
                            ensureGlobalBindingAtProgramTop(decoderIdName, candidate.declPath);
                            const programScope = candidate.declPath.scope.getProgramParent();
                            binding = programScope.getBinding(decoderIdName) || candidate.declPath.scope.getBinding(decoderIdName);
                        }

                        if (binding) {
                            try {
                                renameFast(binding, '__ENCRYPTED_STRING_MAP_DECODER__');
                                logger.log('renamed decoder binding %s -> __ENCRYPTED_STRING_MAP_DECODER__', decoderIdName);
                            } catch (e) {
                                logger.log('failed to rename binding %s: %s', decoderIdName, (e as Error).message);
                            }
                        } else {
                            logger.log('decoder identifier %s has no binding after global insertion attempt; proceeding without rename', decoderIdName);
                        }
                    } catch (e) {
                        logger.log('binding insertion/rename error for %s: %s', decoderIdName, (e as Error).message);
                    }

                    path.stop();
                } else if (logger.enabled && flags.referencesMap) {
                    const missing: string[] = [];
                    if (!(flags.hasMatch || flags.hasSplit || flags.hasReplace || flags.hasBufferFrom || flags.hasAtob)) missing.push('split|match|replace|buffer|atob');
                    if (!flags.hasJoin && !flags.hasMap && !flags.hasFromCharCode && !flags.hasParseInt) missing.push('join|map|fromCharCode|parseInt');
                    logger.log('function referencing %s rejected (no strong signal): signals=%o missing=%s', mapName, {
                        match: flags.hasMatch,
                        split: flags.hasSplit,
                        replace: flags.hasReplace,
                        join: flags.hasJoin,
                        map: flags.hasMap,
                        parseInt: flags.hasParseInt,
                        fromCharCode: flags.hasFromCharCode,
                        buffer: flags.hasBufferFrom,
                        atob: flags.hasAtob,
                    }, missing.join(', '));
                }
            },

            VariableDeclarator(path) {
                if (found) {
                    path.stop();
                    return;
                }
                if (!t.isIdentifier(path.node.id)) return;
                const init = path.node.init;
                if (!init || (!t.isFunctionExpression(init) && !t.isArrowFunctionExpression(init))) return;

                const flags = inspectFunctionNodeForDecoderSignalsLocal(init as any, mapName);

                const hasStrongSignal =
                    flags.hasParseInt ||
                    flags.hasFromCharCode ||
                    flags.hasBufferFrom ||
                    flags.hasAtob ||
                    flags.hasArrayFrom ||
                    flags.hasRegexInCall ||
                    flags.hasMap ||
                    flags.hasReduce ||
                    flags.hasJoin ||
                    flags.hasMatch ||
                    flags.hasSplit ||
                    flags.hasReplace;

                if (flags.referencesMap && hasStrongSignal) {
                    decoderPath = path;
                    decoderIdName = path.node.id.name;
                    found = true;

                    const structure = collectFunctionStructure(init as any);
                    try {
                        if (loggingEnabled) {
                            (dbg as any).apply(undefined, ['decoder-structure', decoderIdName, JSON.stringify(structure, null, 2)]);
                        }
                    } catch {
                        logger.log('decoder structure (compact) %s %o', decoderIdName, structure);
                    }

                    logger.log(
                        'decoder variable declarator candidate found (relaxed): %s signals=%o referencesMap=%s',
                        decoderIdName,
                        {
                            parseInt: flags.hasParseInt,
                            fromCharCode: flags.hasFromCharCode,
                            bufferFrom: flags.hasBufferFrom,
                            atob: flags.hasAtob,
                            arrayFrom: flags.hasArrayFrom,
                            regex: flags.hasRegexInCall,
                            map: flags.hasMap,
                            reduce: flags.hasReduce,
                            join: flags.hasJoin,
                            match: flags.hasMatch,
                            split: flags.hasSplit,
                            replace: flags.hasReplace,
                        },
                        flags.referencesMap,
                    );

                    try {
                        const binding = path.scope.getBinding(decoderIdName);
                        if (binding) {
                            renameFast(binding, '__ENCRYPTED_STRING_MAP_DECODER__');
                            logger.log('renamed decoder binding %s -> __ENCRYPTED_STRING_MAP_DECODER__', decoderIdName);
                        }
                    } catch (e) {
                        logger.log('failed to rename binding %s: %s', decoderIdName, (e as Error).message);
                    }

                    path.stop();
                } else if (logger.enabled && flags.referencesMap) {
                    logger.log('function referencing %s rejected (no strong signal): signals=%o', mapName, {
                        parseInt: flags.hasParseInt,
                        fromCharCode: flags.hasFromCharCode,
                        bufferFrom: flags.hasBufferFrom,
                        atob: flags.hasAtob,
                        arrayFrom: flags.hasArrayFrom,
                        regex: flags.hasRegexInCall,
                        map: flags.hasMap,
                        reduce: flags.hasReduce,
                        join: flags.hasJoin,
                        match: flags.hasMatch,
                        split: flags.hasSplit,
                        replace: flags.hasReplace,
                    });
                }
            },
        });

        if (!decoderPath) {
            logger.log('no decoder found for map %s; trying next candidate', mapName);
            continue;
        }

        // rename map and cache bindings and capture their paths
        let references: NodePath[] | null = null;
        const mapDeclPath: NodePath<t.VariableDeclaration> | null = candidate.declPath;
        const cachePath: NodePath<t.VariableDeclaration> | null = cacheDeclPath || null;

        // rename map binding robustly
        try {
            let mapBinding = candidate.declPath.scope.getBinding(mapName);
            if (!mapBinding) {
                const programScope = candidate.declPath.scope.getProgramParent();
                mapBinding = programScope.getBinding(mapName);
            }

            if (!mapBinding) {
                ensureGlobalBindingAtProgramTop(mapName, candidate.declPath);
                const programScope = candidate.declPath.scope.getProgramParent();
                mapBinding = programScope.getBinding(mapName) || candidate.declPath.scope.getBinding(mapName);
            }

            if (mapBinding) {
                try {
                    renameFast(mapBinding, '__ENCRYPTED_STRING_MAP__');
                    logger.log('renamed map binding %s -> __ENCRYPTED_STRING_MAP__', mapName);
                } catch (e) {
                    logger.log('failed to rename map binding %s: %s', mapName, (e as Error).message);
                }
            } else {
                logger.log('map identifier %s has no binding to rename', mapName);
            }
        } catch (e) {
            logger.log('error while renaming map %s: %s', mapName, (e as Error).message);
        }

        // rename cache binding robustly
        if (foundCacheName) {
            try {
                let cacheBinding = candidate.declPath.scope.getBinding(foundCacheName);
                if (!cacheBinding) {
                    const programScope = candidate.declPath.scope.getProgramParent();
                    cacheBinding = programScope.getBinding(foundCacheName);
                }

                if (!cacheBinding) {
                    ensureGlobalBindingAtProgramTop(foundCacheName, candidate.declPath);
                    const programScope = candidate.declPath.scope.getProgramParent();
                    cacheBinding = programScope.getBinding(foundCacheName) || candidate.declPath.scope.getBinding(foundCacheName);
                }

                if (cacheBinding) {
                    try {
                        renameFast(cacheBinding, '__ENCRYPTED_STRING_MAP_CACHE__');
                        logger.log('renamed cache binding %s -> __ENCRYPTED_STRING_MAP_CACHE__', foundCacheName);
                    } catch (e) {
                        logger.log('failed to rename cache binding %s: %s', foundCacheName, (e as Error).message);
                    }
                } else {
                    logger.log('cache identifier %s has no binding to rename', foundCacheName);
                }
            } catch (e) {
                logger.log('error while renaming cache %s: %s', foundCacheName, (e as Error).message);
            }
        }

        // collect decoder references if available
        if (decoderIdName) {
            try {
                let binding = candidate.declPath.scope.getBinding(decoderIdName);
                if (!binding) {
                    const programScope = candidate.declPath.scope.getProgramParent();
                    binding = programScope.getBinding(decoderIdName);
                }
                if (binding) references = binding.referencePaths;
            } catch {
                // ignore
            }
        }

        result = {
            path: decoderPath,
            references,
            name: '__ENCRYPTED_STRING_MAP_DECODER__',
            originalName: decoderIdName || '',
            mapName,
            mapPath: mapDeclPath,
            cacheName: foundCacheName,
            cachePath,
        };

        logger.log('match success: map=%s decoder=%s cache=%s', result.mapName, result.originalName || result.name, result.cacheName);

        break;
    }

    if (!result) {
        logger.log('end: no encrypted keyed hex->xor map found');
    }

    return result;
}
