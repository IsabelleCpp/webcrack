import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import debug from 'debug';
import type { Transform } from '../ast-utils';

const logger = debug('webcrack:obf-name-dumper');

type Pattern = {
  name: string;
  captureId: m.CapturedMatcher<t.Identifier>;
  predicate: (node: t.Node) => boolean;
};

function contains(node: t.Node, matcher: m.Matcher<any>) {
  let found = false;
  m.matcher<t.Node>((n) => {
    if (found) return false;
    if (matcher.match(n as any)) {
      found = true;
      return true;
    }
    return false;
  }).match(node);
  return found;
}

export default {
  name: 'obf-name-dumper',
  tags: ['safe'],
  visitor() {
    const patterns: Pattern[] = [];

    function addPattern(name: string, captureId: m.CapturedMatcher<t.Identifier>, predicate: (node: t.Node) => boolean) {
      patterns.push({ name, captureId, predicate });
    }

    //
    // __vue__ pattern (unchanged)
    //
    const vueId = m.capture<t.Identifier>(m.identifier());
    const vueMemberMatcher = m.matcher<t.MemberExpression>((node) => {
      if (!t.isMemberExpression(node)) return false;
      const obj = node.object;
      if (!t.isMemberExpression(obj)) return false;
      if (obj.computed || !t.isIdentifier(obj.property)) return false;
      const intermediate = obj.property.name;
      if (intermediate !== '$el' && intermediate !== '$vnode') return false;
      if (!node.computed && t.isIdentifier(node.property)) {
        return vueId.match(node.property as any);
      }
      return false;
    }) as any;

    addPattern('__vue__', vueId, (node: t.Node) => {
      if (t.isAssignmentExpression(node)) {
        return vueMemberMatcher.match(node.left as any);
      }
      if (t.isExpressionStatement(node) && t.isAssignmentExpression(node.expression)) {
        return vueMemberMatcher.match((node.expression as t.AssignmentExpression).left as any);
      }
      return contains(node, vueMemberMatcher);
    });

    //
    // _modules pattern: strict, direct AST inspection to match the sample shape
    //
    const modulesId = m.capture<t.Identifier>(m.identifier());

    // --- small recursive walker used by the direct checks
    function walk(node: t.Node | null | undefined, cb: (n: t.Node) => void) {
      if (!node) return;
      cb(node);
      if (t.isProgram(node)) {
        for (const s of node.body) walk(s, cb);
      } else if (t.isBlockStatement(node)) {
        for (const s of node.body) walk(s, cb);
      } else if (t.isExpressionStatement(node)) {
        walk(node.expression, cb);
      } else if (t.isAssignmentExpression(node)) {
        walk(node.left, cb);
        walk(node.right, cb);
      } else if (t.isCallExpression(node)) {
        walk(node.callee as any, cb);
        for (const a of node.arguments) walk(a as any, cb);
      } else if (t.isMemberExpression(node)) {
        walk(node.object as any, cb);
        walk(node.property as any, cb);
      } else if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
        walk(node.body as any, cb);
        for (const p of node.params) walk(p as any, cb);
      } else if (t.isReturnStatement(node)) {
        walk(node.argument as any, cb);
      } else if (t.isVariableDeclaration(node)) {
        for (const d of node.declarations) walk(d as any, cb);
      } else if (t.isVariableDeclarator(node)) {
        walk(node.id as any, cb);
        walk(node.init as any, cb);
      } else if (t.isIfStatement(node)) {
        walk(node.test as any, cb);
        walk(node.consequent as any, cb);
        walk(node.alternate as any, cb);
      } else if (t.isUnaryExpression(node) || t.isBinaryExpression(node) || t.isLogicalExpression(node)) {
        // conservative handling
        // @ts-ignore
        walk((node as any).left ?? (node as any).argument, cb);
        // @ts-ignore
        walk((node as any).right ?? null, cb);
      } else if (t.isObjectExpression(node)) {
        for (const p of node.properties) {
          // @ts-ignore
          walk((p as any).value, cb);
        }
      } else if (t.isArrayExpression(node)) {
        for (const e of node.elements) walk(e as any, cb);
      } else {
        // fallback: iterate over object properties that look like nodes
        for (const key of Object.keys(node as any)) {
          const val = (node as any)[key];
          if (Array.isArray(val)) {
            for (const el of val) if (el && typeof el.type === 'string') walk(el, cb);
          } else if (val && typeof val.type === 'string') {
            walk(val, cb);
          }
        }
      }
    }

    // Strict prototype-left check: y.prototype.<id> (non-computed)
    function isPrototypeLeft(node: t.Node): node is t.MemberExpression {
      if (!t.isMemberExpression(node)) return false;
      const obj = node.object;
      if (!t.isMemberExpression(obj)) return false;
      if (obj.computed) return false;
      if (!t.isIdentifier(obj.property) || obj.property.name !== 'prototype') return false;
      if (node.computed) return false;
      if (!t.isIdentifier(node.property)) return false;
      return true;
    }

    // Find the first identifier name used as this.<id> inside a function body where the usage is this.<id>.something
    function findThisInnerIdentifier(body: t.Node): string | null {
      let found: string | null = null;
      walk(body, (n) => {
        if (found) return;
        if (!t.isMemberExpression(n)) return;
        // shape: (this.<id>).<something>  => n.object is MemberExpression whose object is ThisExpression
        const obj = n.object;
        if (t.isMemberExpression(obj) && t.isThisExpression(obj.object) && !obj.computed && t.isIdentifier(obj.property)) {
          found = obj.property.name;
          return;
        }
        // also accept direct this.<id> (in case it's used directly)
        if (t.isThisExpression(n.object) && !n.computed && t.isIdentifier(n.property)) {
          found = n.property.name;
          return;
        }
      });
      return found;
    }

    // Find a call like C(this, true) where callee is an Identifier and args[0] === this and args[1] === true
    function hasThisTrueCall(body: t.Node): boolean {
      let ok = false;
      walk(body, (n) => {
        if (ok) return;
        if (!t.isCallExpression(n)) return;
        const callee = n.callee;
        if (!t.isIdentifier(callee)) return;
        const args = n.arguments;
        if (args.length < 2) return;
        if (!t.isThisExpression(args[0])) return;
        if (!t.isBooleanLiteral(args[1])) return;
        if (args[1].value === true) ok = true;
      });
      return ok;
    }

    // Register the strict _modules pattern using direct AST inspection
    addPattern('_modules', modulesId, (node: t.Node) => {
      // accept raw AssignmentExpression or ExpressionStatement wrapping one
      let left: t.Node | null = null;
      let right: t.Node | null = null;

      if (t.isAssignmentExpression(node)) {
        left = node.left;
        right = node.right;
      } else if (t.isExpressionStatement(node) && t.isAssignmentExpression(node.expression)) {
        left = node.expression.left;
        right = node.expression.right;
      } else {
        return false;
      }

      if (!left || !isPrototypeLeft(left)) return false;
      if (!right) return false;
      if (!(t.isFunctionExpression(right) || t.isArrowFunctionExpression(right))) return false;

      const body = (right as t.FunctionExpression | t.ArrowFunctionExpression).body;
      const searchBody = t.isBlockStatement(body) ? body : t.blockStatement([t.returnStatement(body as any)]);

      const innerId = findThisInnerIdentifier(searchBody);
      const hasCall = hasThisTrueCall(searchBody);

      if (innerId && hasCall) {
        // set the capture explicitly so modulesId.current will be available
        modulesId.match(t.identifier(innerId) as any);
        logger('debug', { note: 'matched _modules', assignedProp: (left as t.MemberExpression).property && (left as t.MemberExpression).property.type === 'Identifier' ? ((left as t.MemberExpression).property as t.Identifier).name : null, captured: innerId });
        return true;
      }

      return false;
    });

    const discovered = new Map<string, string>();

    return {
      AssignmentExpression(path) {
        try {
          for (const p of patterns) {
            if (p.predicate(path.node)) {
              const idCap = p.captureId;
              if (idCap && idCap.current) {
                const name = idCap.current.name;
                if (!discovered.has(p.name)) {
                  discovered.set(p.name, name);
                  logger('debug', { note: 'captured', pattern: p.name, capture: name });
                }
              } else {
                logger('error', { message: 'pattern matched but capture empty', pattern: p.name });
              }
            }
          }
        } catch (err) {
          logger('error', { message: 'error while processing AssignmentExpression', error: err });
        }
      },

      ExpressionStatement(path) {
        try {
          for (const p of patterns) {
            if (p.predicate(path.node)) {
              const idCap = p.captureId;
              if (idCap && idCap.current) {
                const name = idCap.current.name;
                if (!discovered.has(p.name)) {
                  discovered.set(p.name, name);
                  logger('debug', { note: 'captured', pattern: p.name, capture: name });
                }
              } else {
                logger('error', { message: 'pattern matched but capture empty', pattern: p.name });
              }
            }
          }
        } catch (err) {
          logger('error', { message: 'error while processing ExpressionStatement', error: err });
        }
      },

      Program: {
        exit(path) {
          try {
            const missing: string[] = [];
            for (const p of patterns) {
              if (!discovered.has(p.name)) missing.push(p.name);
            }

            if (missing.length > 0) {
              logger('error', { message: 'missing patterns', missing });
            }

            if (discovered.size === 0) {
              logger('result', { discovered: {} });
              return;
            }

            const props: t.ObjectProperty[] = [];
            const resultObj: Record<string, string> = {};
            for (const [readable, obf] of discovered) {
              props.push(t.objectProperty(t.identifier(readable), t.stringLiteral(obf)));
              resultObj[readable] = obf;
            }
            const decl = t.variableDeclaration('const', [
              t.variableDeclarator(t.identifier('__obf_names'), t.objectExpression(props)),
            ]);
            path.node.body.push(decl);
            logger('result', { discovered: resultObj });
            // @ts-ignore
            if (typeof this.changes === 'number') this.changes += 1;
          } catch (err) {
            logger('error', { message: 'error in Program.exit', error: err });
          }
        },
      },
    };
  },
} satisfies Transform;
