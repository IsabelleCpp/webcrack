// get-xor-decoder.ts
import { expression } from '@babel/template';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import {
    inlineVariable
} from '../ast-utils';
import type { XorDecoderInfo } from './findXorHexDecoder';

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
