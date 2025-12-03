import { expression } from '@babel/template';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import {
  inlineVariable,
  renameFast
} from '../ast-utils';

/**
 * A function that is called with >= 1 numeric/string arguments
 * and returns a string from the string array. It may also decode
 * the string with Base64 or RC4.
 */
export class Decoder {
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

  collectCalls(): NodePath<t.CallExpression>[] {
    const calls: NodePath<t.CallExpression>[] = [];

    const literalArgument: m.Matcher<t.Expression> = m.or(
      m.binaryExpression(
        m.anything(),
        m.matcher((node) => literalArgument.match(node)),
        m.matcher((node) => literalArgument.match(node)),
      ),
      m.unaryExpression(
        '-',
        m.matcher((node) => literalArgument.match(node)),
      ),
      m.numericLiteral(),
      m.stringLiteral(),
    );

    const literalCall = m.callExpression(
      m.identifier(this.name),
      m.arrayOf(literalArgument),
    );
    const expressionCall = m.callExpression(
      m.identifier(this.name),
      m.arrayOf(m.anyExpression()),
    );

    const conditional = m.capture(m.conditionalExpression());
    const conditionalCall = m.callExpression(m.identifier(this.name), [
      conditional,
    ]);

    const buildExtractedConditional = expression`TEST ? CALLEE(CONSEQUENT) : CALLEE(ALTERNATE)`;

    const binding = this.path.scope.getBinding(this.name)!;
    for (const ref of binding.referencePaths) {
      if (conditionalCall.match(ref.parent)) {
        // decode(test ? 1 : 2) -> test ? decode(1) : decode(2)
        const [replacement] = ref.parentPath!.replaceWith(
          buildExtractedConditional({
            TEST: conditional.current!.test,
            CALLEE: ref.parent.callee,
            CONSEQUENT: conditional.current!.consequent,
            ALTERNATE: conditional.current!.alternate,
          }),
        );
        // some of the scope information is somehow lost after replacing
        replacement.scope.crawl();
      } else if (literalCall.match(ref.parent)) {
        calls.push(ref.parentPath as NodePath<t.CallExpression>);
      } else if (expressionCall.match(ref.parent)) {
        // var n = 1; decode(n); -> decode(1);
        ref.parentPath!.traverse({
          ReferencedIdentifier(path) {
            const varBinding = path.scope.getBinding(path.node.name)!;
            if (!varBinding) return;
            inlineVariable(varBinding, literalArgument, true);
          },
        });
        if (literalCall.match(ref.parent)) {
          calls.push(ref.parentPath as NodePath<t.CallExpression>);
        }
      } else if (ref.parentPath?.isExpressionStatement()) {
        // `decode;` may appear on it's own in some forked obfuscators
        ref.parentPath.remove();
      }
    }

    return calls;
  }
}

export interface StringArray {
  path: NodePath<t.Node>;
  references: NodePath<t.Node>[];
  name: string; // e.g. '__STRING_ARRAY__'
  originalName: string; // e.g. 'rPex3CI'
  length: number;
  foundBy?: 'function' | 'variable' | 'call' | 'expression';
}

/**
 * Find decoder functions that read from the string array and decode entries.
 * - `stringArray` is the result returned by your separate findStringArray function.
 * - `logger` is optional and receives debug strings.
 */
export function findDecoders(
  stringArray: StringArray,
  logger?: (msg: string) => void,
): Decoder[] {
  const decoders: Decoder[] = [];
  logger?.(`findDecoders: starting; originalName=${stringArray.originalName}, currentName=${stringArray.name}, refs=${stringArray.references.length}`);

  // Try to extract a stable name for the function so we can rename its binding.
  function getFunctionName(fnPath: NodePath<t.Node>): string | null {
    if (fnPath.isFunctionDeclaration() && fnPath.node && t.isFunctionDeclaration(fnPath.node) && fnPath.node.id && t.isIdentifier(fnPath.node.id)) {
      return fnPath.node.id.name;
    }
    const parent = fnPath.parentPath;
    if (parent && parent.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
      return parent.node.id.name;
    }
    return null;
  }

  // Check whether a node is a MemberExpression of the form <obj>[<paramIdentifier>]
  function isMemberAccessWithParam(node: t.Node | null | undefined, paramName: string): node is t.MemberExpression {
    if (!node) return false;
    if (!t.isMemberExpression(node)) return false;
    if (node.computed) {
      return t.isIdentifier(node.property) && node.property.name === paramName;
    }
    return t.isIdentifier(node.property) && node.property.name === paramName;
  }

  // Determine whether an expression's object refers to the same binding as the string array.
  function matchesStringArrayObject(obj: t.Expression | t.PrivateName | null | undefined, scope: NodePath['scope']): boolean {
    if (!obj) return false;
    if (!t.isIdentifier(obj)) return false;

    // quick name match against originalName or current name
    if (obj.name === stringArray.originalName || obj.name === stringArray.name) {
      logger?.(`matchesStringArrayObject: name match (${obj.name})`);
      return true;
    }

    // try binding equality: resolve binding for obj and for the string array originalName/current name
    try {
      const objBinding = scope.getBinding(obj.name);
      const arrBindingByOriginal = scope.getBinding(stringArray.originalName);
      const arrBindingByCurrent = scope.getBinding(stringArray.name);

      if (objBinding && (arrBindingByOriginal && objBinding === arrBindingByOriginal)) {
        logger?.(`matchesStringArrayObject: binding matches originalName (${stringArray.originalName})`);
        return true;
      }
      if (objBinding && (arrBindingByCurrent && objBinding === arrBindingByCurrent)) {
        logger?.(`matchesStringArrayObject: binding matches currentName (${stringArray.name})`);
        return true;
      }

      // If stringArray.path points to a VariableDeclarator or similar, compare binding objects across scopes:
      if (stringArray.path && t.isIdentifier((stringArray.path.node as any).id)) {
        const arrId = (stringArray.path.node as any).id as t.Identifier;
        const arrBinding = stringArray.path.scope.getBinding(arrId.name);
        if (objBinding && arrBinding && objBinding === arrBinding) {
          logger?.(`matchesStringArrayObject: binding matches stringArray.path binding (${arrId.name})`);
          return true;
        }
      }
    } catch (e) {
      // binding resolution can throw in some edge cases; ignore and fall through
      logger?.(`matchesStringArrayObject: binding check error: ${(e as Error).message}`);
    }

    logger?.(`matchesStringArrayObject: no match for object ${obj.name}`);
    return false;
  }

  for (const ref of stringArray.references) {
    logger?.(`findDecoders: examining reference node type=${ref.node.type} at ${ref.node.start ?? 'unknown'}`);

    const fnPath = ref.findParent((p) =>
      p.isFunctionDeclaration() || p.isFunctionExpression() || p.isArrowFunctionExpression(),
    ) as NodePath<t.Node> | null;

    if (!fnPath) {
      logger?.('findDecoders: no enclosing function for this reference');
      continue;
    }

    logger?.(`findDecoders: found enclosing function node type=${fnPath.node.type}`);

    // get first parameter (index param)
    const params = (fnPath.node as any).params as t.Function['params'] | undefined;
    if (!params || params.length === 0) {
      logger?.('findDecoders: function has no params — skipping');
      continue;
    }
    const firstParam = params[0];
    if (!t.isIdentifier(firstParam)) {
      logger?.('findDecoders: first param is not identifier — skipping');
      continue;
    }
    const paramName = firstParam.name;
    logger?.(`findDecoders: function param name=${paramName}`);

    let found = false;
    let decoderCalleeName: string | null = null;
    let cacheIdentifierName: string | null = null;

    if (fnPath.node && t.isBlockStatement((fnPath.node as any).body)) {
      const stmts = ((fnPath.node as any).body as t.BlockStatement).body;

      for (let i = 0; i < stmts.length && !found; i++) {
        const stmt = stmts[i];

        // Case A: IfStatement with typeof <cache>[param] === ...
        if (t.isIfStatement(stmt)) {
          const test = stmt.test;
          if (
            t.isBinaryExpression(test) &&
            (test.operator === '===' || test.operator === '==') &&
            t.isUnaryExpression(test.left) &&
            test.left.operator === 'typeof' &&
            isMemberAccessWithParam(test.left.argument, paramName)
          ) {
            const member = test.left.argument as t.MemberExpression;
            if (t.isIdentifier(member.object)) cacheIdentifierName = member.object.name;
            logger?.(`findDecoders: found typeof-check on ${cacheIdentifierName}[${paramName}]`);

            const consequent = stmt.consequent;
            const consequentBody = t.isBlockStatement(consequent) ? consequent.body : [consequent];

            for (const cstmt of consequentBody) {
              if (t.isReturnStatement(cstmt) && cstmt.argument && t.isAssignmentExpression(cstmt.argument)) {
                const assign = cstmt.argument;
                if (!isMemberAccessWithParam(assign.left as t.Node, paramName)) continue;
                const leftMember = assign.left as t.MemberExpression;
                if (t.isIdentifier(leftMember.object)) cacheIdentifierName = leftMember.object.name;

                if (t.isCallExpression(assign.right) && assign.right.arguments.length > 0) {
                  const call = assign.right;
                  // find an argument that is array[param] — but match robustly
                  const argIsArrayAccess = call.arguments.find((a) => {
                    if (!t.isMemberExpression(a)) return false;
                    const ma = a as t.MemberExpression;
                    if (!t.isIdentifier(ma.object)) return false;
                    // robust match: name OR binding equality
                    return matchesStringArrayObject(ma.object, ref.scope);
                  });

                  if (argIsArrayAccess) {
                    if (t.isIdentifier(call.callee)) decoderCalleeName = call.callee.name;
                    logger?.(`findDecoders: decoder call ${decoderCalleeName} detected inside if-consequent`);
                    found = true;
                    break;
                  } else {
                    logger?.('findDecoders: call in if-consequent did not contain array access matching stringArray');
                  }
                }
              }
            }
          }
        }

        // Case B: direct return assignment: return cache[param] = decoder(array[param]);
        if (!found && t.isReturnStatement(stmt) && stmt.argument && t.isAssignmentExpression(stmt.argument)) {
          const assign = stmt.argument;
          if (isMemberAccessWithParam(assign.left as t.Node, paramName)) {
            const leftMember = assign.left as t.MemberExpression;
            if (t.isIdentifier(leftMember.object)) cacheIdentifierName = leftMember.object.name;

            if (t.isCallExpression(assign.right)) {
              const call = assign.right;
              const argIsArrayAccess = call.arguments.find((a) => {
                if (!t.isMemberExpression(a)) return false;
                const ma = a as t.MemberExpression;
                if (!t.isIdentifier(ma.object)) return false;
                return matchesStringArrayObject(ma.object, ref.scope);
              });

              if (argIsArrayAccess) {
                if (t.isIdentifier(call.callee)) decoderCalleeName = call.callee.name;
                logger?.(`findDecoders: decoder call ${decoderCalleeName} detected in direct return assignment`);
                found = true;
                break;
              } else {
                logger?.('findDecoders: direct return assignment call did not contain array access matching stringArray');
              }
            }
          }
        }

        // Case C: final return of cache[param] after an if above
        if (!found && t.isReturnStatement(stmt) && stmt.argument && t.isMemberExpression(stmt.argument)) {
          const retMember = stmt.argument;
          if (isMemberAccessWithParam(retMember, paramName) && t.isIdentifier(retMember.object)) {
            if (!cacheIdentifierName) cacheIdentifierName = retMember.object.name;
            logger?.(`findDecoders: final return of ${cacheIdentifierName}[${paramName}] found — searching previous if for decoder`);

            for (let j = 0; j < i && !found; j++) {
              const prev = stmts[j];
              if (!t.isIfStatement(prev)) continue;
              const test = prev.test;
              if (
                t.isBinaryExpression(test) &&
                (test.operator === '===' || test.operator === '==') &&
                t.isUnaryExpression(test.left) &&
                test.left.operator === 'typeof' &&
                isMemberAccessWithParam(test.left.argument, paramName)
              ) {
                const consequent = prev.consequent;
                const consequentBody = t.isBlockStatement(consequent) ? consequent.body : [consequent];
                for (const cstmt of consequentBody) {
                  if (t.isReturnStatement(cstmt) && cstmt.argument && t.isAssignmentExpression(cstmt.argument)) {
                    const assign = cstmt.argument;
                    if (t.isCallExpression(assign.right)) {
                      const call = assign.right;
                      const argIsArrayAccess = call.arguments.find((a) => {
                        if (!t.isMemberExpression(a)) return false;
                        const ma = a as t.MemberExpression;
                        if (!t.isIdentifier(ma.object)) return false;
                        return matchesStringArrayObject(ma.object, ref.scope);
                      });
                      if (argIsArrayAccess) {
                        if (t.isIdentifier(call.callee)) decoderCalleeName = call.callee.name;
                        logger?.(`findDecoders: decoder call ${decoderCalleeName} detected in previous if`);
                        found = true;
                        break;
                      } else {
                        logger?.('findDecoders: previous if contained a call but its args did not match stringArray');
                      }
                    }
                  }
                }
              }
            }
          }
        }
      } // end for stmts
    } // end if block statement

    if (!found) {
      logger?.('findDecoders: no decoder pattern found in this function');
      continue;
    }

    // determine a stable name for the function so we can rename its binding
    const oldName = getFunctionName(fnPath);
    const newName = `__DECODE_${decoders.length}__`;

    if (oldName) {
      const binding = fnPath.scope.getBinding(oldName);
      if (binding) {
        logger?.(`findDecoders: renaming decoder ${oldName} -> ${newName}`);
        renameFast(binding, newName);
        decoders.push(new Decoder(oldName, newName, fnPath as NodePath<t.FunctionDeclaration>));
        continue;
      }
    }

    // fallback: use decoderCalleeName or synthesized name
    const fallbackOldName = oldName ?? decoderCalleeName ?? `decoder_${decoders.length}`;
    logger?.(`findDecoders: pushing decoder (fallback name) ${fallbackOldName} -> ${newName}`);
    decoders.push(new Decoder(fallbackOldName, newName, fnPath as NodePath<t.FunctionDeclaration>));
  } // end for references

  logger?.(`findDecoders: finished; found ${decoders.length} decoder(s)`);
  return decoders;
}
