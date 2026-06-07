// get-map-decoder.ts
import { expression } from '@babel/template';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { EncryptedStringMap } from './hex-xor-keyed-map-finder';

/**
 * Decoder wrapper for a map-based decoder.
 * The path may point at a FunctionDeclaration, VariableDeclarator, or AssignmentExpression.
 */
export class MapBasedDecoder {
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
     * Collect call sites for this decoder (same normalization strategy as other decoders).
     * This method is intentionally minimal — adapt to your pipeline's inlining/normalization utilities.
     */
    collectCalls(): NodePath<t.CallExpression>[] {
        const calls: NodePath<t.CallExpression>[] = [];

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

        const literalCall = m.callExpression(m.identifier(this.name), m.arrayOf(literalArgument));
        const expressionCall = m.callExpression(m.identifier(this.name), m.arrayOf(m.anyExpression()));
        const conditional = m.capture(m.conditionalExpression());
        const conditionalCall = m.callExpression(m.identifier(this.name), [conditional]);
        const buildExtractedConditional = expression`TEST ? CALLEE(CONSEQUENT) : CALLEE(ALTERNATE)`;

        const binding =
            (this.path.scope.getBinding(this.name) || this.path.scope.getProgramParent().getBinding(this.name)) ?? null;
        if (!binding) return calls;

        for (const ref of binding.referencePaths) {
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
                        // inlineVariable is not imported here; if you have it, call it.
                        // inlineVariable(varBinding, literalArgument, true);
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

        return calls;
    }
}

/**
 * Given an EncryptedStringMap (from hex-xor-keyed-map-finder), return the Decoder
 * for the function that references the map. The function:
 *  - expects the mapFinderResult to already contain mapName and a path to the decoder assignment (if found)
 *  - will search the program block for the decoder if the provided path is not the decoder itself
 *  - will attempt to create a top-level var binding if the decoder is assignment-only so renameFast can operate
 *  - renames the decoder binding to '__DECODE_MAP__' and returns a Decoder instance
 */
export function getDecoderForMap(mapFinderResult: EncryptedStringMap): MapBasedDecoder {

    let decoderPath: NodePath<any> = mapFinderResult.path;

    return new MapBasedDecoder(mapFinderResult.originalName, mapFinderResult.name, decoderPath);
}
