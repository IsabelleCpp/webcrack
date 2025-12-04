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
 *
 * Changes made:
 * - Decoder now stores a path to the actual callee function and any dependent functions it calls.
 * - collectCalls now inlines calls by replacing call sites with an IIFE built from the decoder function
 *   and its dependencies (cloned into the IIFE) so runtime reference errors are avoided.
 */
export class Decoder {
  originalName: string;
  name: string;
  path: NodePath<t.FunctionDeclaration>;
  /** Path to the actual callee function (the function that performs decoding) */
  calleePath: NodePath<t.FunctionDeclaration> | null;
  /** Any other function dependencies called by the callee; these will be cloned into the IIFE */
  dependencyPaths: NodePath<t.FunctionDeclaration>[];

  constructor(
    originalName: string,
    name: string,
    path: NodePath<t.FunctionDeclaration>,
    calleePath: NodePath<t.FunctionDeclaration> | null = null,
    dependencyPaths: NodePath<t.FunctionDeclaration>[] = [],
  ) {
    this.originalName = originalName;
    this.name = name;
    this.path = path;
    this.calleePath = calleePath;
    this.dependencyPaths = dependencyPaths;
  }

  /**
   * Find call sites referencing this decoder and inline them.
   *
   * Inlining strategy:
   * - Build a FunctionExpression cloned from the callee function (or from the decoder function if calleePath is null).
   * - Prepend cloned dependency function declarations inside the function expression body so they are available as locals.
   * - Replace the call expression with a CallExpression that invokes the cloned FunctionExpression with the original arguments.
   *
   * This avoids runtime reference errors caused by missing bindings (the functions are embedded at the call site).
   */
  collectCalls(): NodePath<t.CallExpression>[] {
    const calls: NodePath<t.CallExpression>[] = [];

    // A matcher for literal-ish arguments (used when inlining variables)
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
      // Handle conditional extraction as before
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
        continue;
      }

      if (literalCall.match(ref.parent)) {
        calls.push(ref.parentPath as NodePath<t.CallExpression>);
        // We'll inline below after collecting
      } else if (expressionCall.match(ref.parent)) {
        // First: inline array member accesses like kyJECEl[14] -> 88
        ref.parentPath!.traverse({
          MemberExpression(path) {
            const node = path.node;
            // only handle computed member expressions with identifier object
            if (!node.computed || !t.isIdentifier(node.object)) return;

            const objName = node.object.name;
            const objBinding = path.scope.getBinding(objName);
            if (!objBinding) return;

            const declarator = objBinding.path.node;
            if (!t.isVariableDeclarator(declarator)) return;
            const init = declarator.init;
            if (!t.isArrayExpression(init)) return;

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

            const element = init.elements[idx];
            if (!element) return;

            // replace with the array element (clone to avoid reusing nodes)
            path.replaceWith(t.cloneNode(element as t.Expression, /* deep */ true));
          },
        });

        // Then: inline simple variables so decode(n) -> decode(1)
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

    // If we have a calleePath (the actual function that does decoding) or at least the decoder function path,
    // prepare a FunctionExpression and dependency clones to inline at each call site.
    const calleeFnPath = this.calleePath ?? (this.path.isFunctionDeclaration() ? (this.path as NodePath<t.FunctionDeclaration>) : null);
    let calleeFnNode: t.FunctionDeclaration | null = null;
    if (calleeFnPath && t.isFunctionDeclaration(calleeFnPath.node)) {
      calleeFnNode = calleeFnPath.node;
    } else if (this.path && t.isFunctionDeclaration(this.path.node)) {
      calleeFnNode = this.path.node;
    }

    // Helper to collect dependency function declarations (cloned)
    const clonedDependencies: t.FunctionDeclaration[] = [];
    for (const depPath of this.dependencyPaths) {
      if (depPath && t.isFunctionDeclaration(depPath.node)) {
        clonedDependencies.push(t.cloneNode(depPath.node, /* deep */ true) as t.FunctionDeclaration);
      }
    }

    // Inline each collected call site by replacing it with an IIFE that contains the callee and dependencies
    for (const callPath of calls) {
      // Build a function expression from the callee function node
      if (!calleeFnNode) {
        // If we don't have a callee function node, skip inlining for this call
        continue;
      }

      // Clone callee function as a FunctionExpression
      const clonedCallee = t.functionExpression(
        null,
        calleeFnNode.params.map((p) => t.cloneNode(p, true) as t.Identifier | t.Pattern),
        t.cloneNode(calleeFnNode.body, true) as t.BlockStatement,
        false,
        false,
      );

      // Insert cloned dependency function declarations at the top of the callee body so they are available as locals.
      // We do this by creating a new BlockStatement that starts with function declarations (cloned) followed by the original body.
      const clonedDepDecls = clonedDependencies.map((fnDecl) => {
        // Keep as FunctionDeclaration nodes; they'll be inserted into the body as-is.
        return t.cloneNode(fnDecl, true) as t.FunctionDeclaration;
      });

      // Ensure the function expression has a block body we can modify
      const calleeBody = clonedCallee.body as t.BlockStatement;
      // Prepend dependency declarations
      calleeBody.body = [...clonedDepDecls, ...calleeBody.body];

      // Build the call expression that invokes the cloned function with the original arguments
      const iifeCall = t.callExpression(
        clonedCallee,
        callPath.node.arguments.map((arg) => t.cloneNode(arg, true) as t.Expression),
      );

      // Replace the original call with the IIFE call
      callPath.replaceWith(iifeCall);
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
  /** Optional JS source string that defines the array, e.g. `var __STRING_ARRAY__ = ["a","b"];` */
  definition?: string;
  foundBy?: 'function' | 'variable' | 'call' | 'expression';
}


/**
 * Find decoder functions that read from the string array and decode entries.
 * - `stringArray` is the result returned by your separate findStringArray function.
 * - `logger` is optional and receives debug strings.
 *
 * Changes made:
 * - Removed the typeof/cache-specific checks. Instead we look for call expressions inside functions
 *   whose arguments include a member expression that matches the string array binding.
 * - When a decoder is found we attempt to locate the actual callee function (the function that performs decoding)
 *   and any other function dependencies it calls. We rename the decoder and its dependencies to stable names
 *   and store their paths in the Decoder instance.
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
    let calleePath: NodePath<t.FunctionDeclaration> | null = null;
    const dependencyPaths: NodePath<t.FunctionDeclaration>[] = [];

    // New approach:
    // Walk the function body and look for CallExpressions where one of the arguments is an array access
    // that matches the stringArray binding. When found, treat the callee as the decoder callee.
    if (fnPath.node && t.isBlockStatement((fnPath.node as any).body)) {
      const stmts = ((fnPath.node as any).body as t.BlockStatement).body;

      // Simple scan for call expressions in statements
      for (let i = 0; i < stmts.length && !found; i++) {
        const stmt = stmts[i];

        // Traverse this statement to find CallExpressions that use the string array
        let stop = false;
        (function traverseNode(node: t.Node) {
          if (stop) return;
          if (t.isCallExpression(node)) {
            // Check if any argument is a MemberExpression that matches the string array
            const argIsArrayAccess = node.arguments.find((a) => {
              if (!t.isMemberExpression(a)) return false;
              const ma = a as t.MemberExpression;
              if (!t.isIdentifier(ma.object)) return false;
              return matchesStringArrayObject(ma.object, ref.scope);
            });

            if (argIsArrayAccess) {
              // Found a candidate decoder call
              if (t.isIdentifier(node.callee)) {
                decoderCalleeName = node.callee.name;
                logger?.(`findDecoders: decoder call ${decoderCalleeName} detected`);
                found = true;
                stop = true;
                return;
              } else if (t.isMemberExpression(node.callee) && t.isIdentifier(node.callee.property)) {
                // e.g., obj.decode(array[idx]) — try to resolve property binding if possible
                decoderCalleeName = node.callee.property.name;
                logger?.(`findDecoders: decoder call (member) ${decoderCalleeName} detected`);
                found = true;
                stop = true;
                return;
              }
            }
          }

          // Recurse into child nodes
          for (const key of Object.keys(node) as (keyof t.Node)[]) {
            const child = (node as any)[key];
            if (Array.isArray(child)) {
              for (const c of child) {
                if (c && typeof c.type === 'string') traverseNode(c);
                if (stop) return;
              }
            } else if (child && typeof child.type === 'string') {
              traverseNode(child);
              if (stop) return;
            }
          }
        })(stmt);
      }
    }

    if (!found) {
      logger?.('findDecoders: no decoder pattern found in this function (new scan)');
      continue;
    }

    // If we found a decoder callee name, try to resolve its binding to get the function path
    if (decoderCalleeName) {
      try {
        const calleeBinding = fnPath.scope.getBinding(decoderCalleeName);
        if (calleeBinding && calleeBinding.path && (calleeBinding.path.isFunctionDeclaration() || calleeBinding.path.isFunctionExpression())) {
          // Normalize to FunctionDeclaration path if possible
          if (calleeBinding.path.isFunctionDeclaration()) {
            calleePath = calleeBinding.path as NodePath<t.FunctionDeclaration>;
          } else if (calleeBinding.path.isFunctionExpression()) {
            // If it's a function expression assigned to a variable, try to find the variable declarator and convert to a FunctionDeclaration-like node
            const parent = calleeBinding.path.parentPath;
            if (parent && parent.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
              // If the function expression is assigned to a variable, we can still use the function expression node as the callee
              // For simplicity, if it's a function expression, attempt to create a synthetic FunctionDeclaration wrapper when inlining.
              // But for storing path, keep the original path (function expression path).
              // We'll accept function expression paths as dependencies as well.
              // Cast to FunctionDeclaration path only when it's actually a declaration.
              // Here we store the binding.path as any to be used later for cloning.
              if (calleeBinding.path.isFunctionExpression()) {
                // Try to find an enclosing variable declarator that holds the function expression
                const varDecl = calleeBinding.path.findParent((p) => p.isVariableDeclarator());
                if (varDecl && varDecl.node && t.isVariableDeclarator(varDecl.node) && t.isIdentifier(varDecl.node.id)) {
                  // If we can find a variable declarator, attempt to locate a function declaration in the same scope with that name
                  const maybeFnDecl = varDecl.scope.getBinding(varDecl.node.id.name);
                  if (maybeFnDecl && maybeFnDecl.path && maybeFnDecl.path.isFunctionDeclaration()) {
                    calleePath = maybeFnDecl.path as NodePath<t.FunctionDeclaration>;
                  } else {
                    // As a fallback, if the function expression itself is the only representation, try to wrap it later when inlining.
                    // We'll store the function expression path as a dependency by casting.
                    // To keep types consistent, set calleePath to null and rely on this.path as fallback.
                    calleePath = null;
                  }
                } else {
                  calleePath = null;
                }
              }
            }
          }
        }
      } catch (e) {
        logger?.(`findDecoders: error resolving callee binding: ${(e as Error).message}`);
      }
    }

    // If we have a calleePath, scan its body for other function calls that resolve to local function bindings.
    if (calleePath) {
      try {
        calleePath.traverse({
          CallExpression(callPath) {
            const callee = callPath.node.callee;
            if (t.isIdentifier(callee)) {
              const depBinding = callPath.scope.getBinding(callee.name);
              if (depBinding && depBinding.path) {
                // If the binding is a function declaration or function expression assigned to a variable, capture it
                if (depBinding.path.isFunctionDeclaration()) {
                  dependencyPaths.push(depBinding.path as NodePath<t.FunctionDeclaration>);
                } else if (depBinding.path.isVariableDeclarator()) {
                  // If it's a variable declarator with a function expression initializer, try to capture the function expression path
                  const init = depBinding.path.node.init;
                  if (init && t.isFunctionExpression(init)) {
                    // Find the function expression path
                    const fnExprPath = depBinding.path.get('init') as NodePath<t.FunctionExpression>;
                    // We can't type-cast to FunctionDeclaration, but we'll attempt to treat it as a dependency by finding a declaration equivalent.
                    // For simplicity, if we can find a function declaration with the same name in the same scope, prefer that.
                    const maybeDecl = depBinding.path.scope.getBinding(depBinding.path.node.id && t.isIdentifier(depBinding.path.node.id) ? depBinding.path.node.id.name : '');
                    if (maybeDecl && maybeDecl.path && maybeDecl.path.isFunctionDeclaration()) {
                      dependencyPaths.push(maybeDecl.path as NodePath<t.FunctionDeclaration>);
                    } else {
                      // Otherwise, skip; the inliner will still clone the callee function and dependencies that are function declarations.
                    }
                  }
                }
              }
            }
          },
        });
      } catch (e) {
        logger?.(`findDecoders: error scanning callee for dependencies: ${(e as Error).message}`);
      }
    }

    // determine a stable name for the function so we can rename its binding
    const oldName = getFunctionName(fnPath);
    const newName = `__DECODE_${decoders.length}__`;

    if (oldName) {
      const binding = fnPath.scope.getBinding(oldName);
      if (binding) {
        logger?.(`findDecoders: renaming decoder ${oldName} -> ${newName}`);
        renameFast(binding, newName);
        // Also rename callee and dependencies if we found them
        let calleePathToStore: NodePath<t.FunctionDeclaration> | null = null;
        if (decoderCalleeName) {
          const calleeBinding = fnPath.scope.getBinding(decoderCalleeName);
          if (calleeBinding && calleeBinding.path && calleeBinding.path.isFunctionDeclaration()) {
            const calleeOldName = decoderCalleeName;
            const calleeNewName = `__DECODE_CALLEE_${decoders.length}__`;
            logger?.(`findDecoders: renaming callee ${calleeOldName} -> ${calleeNewName}`);
            renameFast(calleeBinding, calleeNewName);
            // update stored callee path
            calleePathToStore = calleeBinding.path as NodePath<t.FunctionDeclaration>;
          }
        }

        // Rename dependencies
        const depPathsToStore: NodePath<t.FunctionDeclaration>[] = [];
        for (const dep of dependencyPaths) {
          if (dep && dep.node && t.isFunctionDeclaration(dep.node) && dep.node.id && t.isIdentifier(dep.node.id)) {
            const depBinding = dep.scope.getBinding(dep.node.id.name);
            if (depBinding) {
              const depNewName = `__DECODE_DEP_${decoders.length}_${dep.node.id.name}`;
              logger?.(`findDecoders: renaming dependency ${dep.node.id.name} -> ${depNewName}`);
              renameFast(depBinding, depNewName);
              // After renaming, get the updated binding path
              const updated = dep.scope.getBinding(depNewName);
              if (updated && updated.path && updated.path.isFunctionDeclaration()) {
                depPathsToStore.push(updated.path as NodePath<t.FunctionDeclaration>);
              }
            }
          }
        }

        decoders.push(new Decoder(oldName, newName, fnPath as NodePath<t.FunctionDeclaration>, calleePathToStore, depPathsToStore));
        continue;
      }
    }

    // fallback: use decoderCalleeName or synthesized name
    const fallbackOldName = oldName ?? decoderCalleeName ?? `decoder_${decoders.length}`;
    logger?.(`findDecoders: pushing decoder (fallback name) ${fallbackOldName} -> ${newName}`);

    // Attempt to rename callee and dependencies even if the decoder itself couldn't be renamed
    let calleePathToStore: NodePath<t.FunctionDeclaration> | null = null;
    if (decoderCalleeName) {
      try {
        const calleeBinding = fnPath.scope.getBinding(decoderCalleeName);
        if (calleeBinding && calleeBinding.path && calleeBinding.path.isFunctionDeclaration()) {
          const calleeNewName = `__DECODE_CALLEE_${decoders.length}__`;
          logger?.(`findDecoders: renaming callee ${decoderCalleeName} -> ${calleeNewName}`);
          renameFast(calleeBinding, calleeNewName);
          calleePathToStore = calleeBinding.path as NodePath<t.FunctionDeclaration>;
        }
      } catch (e) {
        logger?.(`findDecoders: error renaming callee: ${(e as Error).message}`);
      }
    }

    const depPathsToStore: NodePath<t.FunctionDeclaration>[] = [];
    for (const dep of dependencyPaths) {
      if (dep && dep.node && t.isFunctionDeclaration(dep.node) && dep.node.id && t.isIdentifier(dep.node.id)) {
        const depBinding = dep.scope.getBinding(dep.node.id.name);
        if (depBinding) {
          const depNewName = `__DECODE_DEP_${decoders.length}_${dep.node.id.name}`;
          logger?.(`findDecoders: renaming dependency ${dep.node.id.name} -> ${depNewName}`);
          renameFast(depBinding, depNewName);
          const updated = dep.scope.getBinding(depNewName);
          if (updated && updated.path && updated.path.isFunctionDeclaration()) {
            depPathsToStore.push(updated.path as NodePath<t.FunctionDeclaration>);
          }
        }
      }
    }

    decoders.push(new Decoder(fallbackOldName, newName, fnPath as NodePath<t.FunctionDeclaration>, calleePathToStore, depPathsToStore));
  } // end for references

  logger?.(`findDecoders: finished; found ${decoders.length} decoder(s)`);
  return decoders;
}
