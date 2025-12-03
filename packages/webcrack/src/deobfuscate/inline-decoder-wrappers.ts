import type { NodePath } from '@babel/traverse';
import type * as tt from '@babel/types';
import * as t from '@babel/types';
import type { Transform } from '../ast-utils';
import { inlineFunctionAliases, inlineVariableAliases } from '../ast-utils';

export default {
  name: 'inline-decoder-wrappers',
  tags: ['unsafe'],
  scope: true,
  run(ast, state, decoder) {
    if (!decoder?.node.id) return;

    const decoderName = decoder.node.id.name;
    const decoderBinding = decoder.parentPath.scope.getBinding(decoderName);
    if (decoderBinding) {
      state.changes += inlineVariableAliases(decoderBinding).changes;
      state.changes += inlineFunctionAliases(decoderBinding).changes;
    }

    /**
     * Replace computed MemberExpression nodes inside the decoder function body
     * when the object is an identifier bound to an ArrayExpression initializer.
     */
    function inlineArrayAccessesInDecoderBody(decoderPath: NodePath<tt.FunctionDeclaration>) {
      // traverse only the decoder function body
      const bodyPath = decoderPath.get('body');
      bodyPath.traverse({
        MemberExpression(path: NodePath<tt.MemberExpression>) {
          const node = path.node;

          // only handle computed member expressions like arr[3]
          if (!node.computed) return;

          // object must be an identifier (arr[...])
          if (!t.isIdentifier(node.object)) return;
          const objName = node.object.name;

          // find the binding visible from this path (works for decoder-local or parent-scope arrays)
          const binding = path.scope.getBinding(objName);
          if (!binding) return;

          // binding must be a variable declarator with an ArrayExpression initializer
          const declPath = binding.path;
          if (!declPath || !declPath.isVariableDeclarator()) return;
          const init = declPath.node.init;
          if (!t.isArrayExpression(init)) return;

          // skip arrays that are mutated or reassigned
          if (binding.constantViolations && binding.constantViolations.length > 0) return;

          // resolve numeric index (supports simple unary negative)
          let idx: number | null = null;
          if (t.isNumericLiteral(node.property)) {
            idx = node.property.value;
          } else if (
            t.isUnaryExpression(node.property) &&
            node.property.operator === '-' &&
            t.isNumericLiteral(node.property.argument)
          ) {
            idx = -node.property.argument.value;
          } else {
            return;
          }

          // guard index bounds
          if (idx < 0 || idx >= init.elements.length) return;

          const element = init.elements[idx];
          if (!element) return;

          // replace with a cloned node to avoid reusing AST nodes
          path.replaceWith(t.cloneNode(element as tt.Expression, /* deep */ true));
          state.changes++;
        },
      });
    }

    // Run the inliner on the decoder function itself
    inlineArrayAccessesInDecoderBody(decoder);
  },
} satisfies Transform<NodePath<t.FunctionDeclaration>>;
