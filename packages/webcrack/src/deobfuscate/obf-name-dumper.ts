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

    function register(name: string, predicate: (node: t.Node) => boolean) {
      const capture = m.capture<t.Identifier>(m.identifier());
      patterns.push({ name, captureId: capture, predicate });
      return capture;
    }

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

    const vueId = register('__vue__', (node: t.Node) => {
      const vueMemberMatcher = m.matcher<t.MemberExpression>((n) => {
        if (!t.isMemberExpression(n)) return false;
        const obj = n.object;
        if (!t.isMemberExpression(obj)) return false;
        if (obj.computed || !t.isIdentifier(obj.property)) return false;
        const intermediate = obj.property.name;
        if (intermediate !== '$el' && intermediate !== '$vnode') return false;
        if (!n.computed && t.isIdentifier(n.property)) {
          return vueId.match(n.property as any);
        }
        return false;
      }) as any;
      if (t.isAssignmentExpression(node)) {
        return vueMemberMatcher.match(node.left as any);
      }
      if (t.isExpressionStatement(node) && t.isAssignmentExpression(node.expression)) {
        return vueMemberMatcher.match((node.expression as t.AssignmentExpression).left as any);
      }
      return contains(node, vueMemberMatcher);
    });

    const modulesId = register('_modules', (node: t.Node) => {
      function findThisInnerIdentifier(body: t.Node): string | null {
        let found: string | null = null;
        walk(body, (n) => {
          if (found) return;
          if (!t.isMemberExpression(n)) return;
          const obj = n.object;
          if (t.isMemberExpression(obj) && t.isThisExpression(obj.object) && !obj.computed && t.isIdentifier(obj.property)) {
            found = obj.property.name;
            return;
          }
          if (t.isThisExpression(n.object) && !n.computed && t.isIdentifier(n.property)) {
            found = n.property.name;
            return;
          }
        });
        return found;
      }
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
        modulesId.match(t.identifier(innerId) as any);
        return true;
      }
      return false;
    });

    const dataId = register('_data', (node: t.Node) => {
      function findThisAlias(body: t.Node): string | null {
        let alias: string | null = null;
        walk(body, (n) => {
          if (alias) return;
          if (!t.isVariableDeclarator(n)) return;
          if (!t.isIdentifier(n.id)) return;
          const idName = n.id.name;
          const init = n.init;
          if (init && t.isThisExpression(init)) {
            alias = idName;
          }
        });
        return alias;
      }
      function findAliasVmStateAssignment(body: t.Node, aliasName: string, paramName: string): string | null {
        let found: string | null = null;
        walk(body, (n) => {
          if (found) return;
          if (!t.isAssignmentExpression(n)) return;
          const left = n.left;
          if (!t.isMemberExpression(left)) return;
          if (left.computed) return;
          if (!t.isIdentifier(left.property) || left.property.name !== '$$state') return;
          const inner = left.object;
          if (!t.isMemberExpression(inner)) return;
          if (inner.computed) return;
          if (!t.isIdentifier(inner.property)) return;
          const dataName = inner.property.name;
          const vmObj = inner.object;
          if (!t.isMemberExpression(vmObj)) return;
          if (vmObj.computed) return;
          if (!t.isIdentifier(vmObj.property) || vmObj.property.name !== '_vm') return;
          if (!t.isIdentifier(vmObj.object) || vmObj.object.name !== aliasName) return;
          const right = n.right;
          if (!t.isIdentifier(right)) return;
          if (right.name !== paramName) return;
          found = dataName;
        });
        return found;
      }
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
      const outerParams = (right as t.FunctionExpression | t.ArrowFunctionExpression).params;
      if (!outerParams || outerParams.length === 0) return false;
      const firstParam = outerParams[0];
      if (!t.isIdentifier(firstParam)) return false;
      const paramName = firstParam.name;
      const body = (right as t.FunctionExpression | t.ArrowFunctionExpression).body;
      const searchBody = t.isBlockStatement(body) ? body : t.blockStatement([t.returnStatement(body as any)]);
      const alias = findThisAlias(searchBody);
      if (!alias) return false;
      let matchedDataName: string | null = null;
      walk(searchBody, (n) => {
        if (matchedDataName) return;
        if (!t.isCallExpression(n)) return;
        const callee = n.callee;
        if (!t.isMemberExpression(callee)) return;
        if (!t.isThisExpression(callee.object)) return;
        if (callee.computed || !t.isIdentifier(callee.property)) return;
        if (!n.arguments || n.arguments.length === 0) return;
        const firstArg = n.arguments[0];
        if (!(t.isFunctionExpression(firstArg) || t.isArrowFunctionExpression(firstArg))) return;
        const cbBody = (firstArg as t.FunctionExpression | t.ArrowFunctionExpression).body;
        const cbSearchBody = t.isBlockStatement(cbBody) ? cbBody : t.blockStatement([t.returnStatement(cbBody as any)]);
        const dataName = findAliasVmStateAssignment(cbSearchBody, alias, paramName);
        if (dataName) matchedDataName = dataName;
      });
      if (matchedDataName) {
        dataId.match(t.identifier(matchedDataName) as any);
        return true;
      }
      return false;
    });

    const appearanceId = register('appearance_obf', (node: t.Node) => {
      function collectSequence(root: t.Node): string[] {
        const seq: string[] = [];
        walk(root, (n) => {
          if (!t.isCallExpression(n)) return;
          const outer = n;
          if (!outer.arguments || outer.arguments.length < 2) return;
          const firstArg = outer.arguments[0];
          const secondArg = outer.arguments[1];
          if (!t.isThisExpression(firstArg)) return;
          if (!t.isStringLiteral(secondArg)) return;
          const callee = outer.callee;
          if (!t.isCallExpression(callee)) return;
          const innerCallee = callee.callee;
          if (!(t.isIdentifier(innerCallee) || t.isMemberExpression(innerCallee))) return;
          seq.push(secondArg.value);
        });
        return seq;
      }
      const seq = collectSequence(node);
      if (seq.length === 0) return false;
      for (let i = 1; i < seq.length; i++) {
        if (seq[i] === 'sun') {
          const prev = seq[i - 1];
          if (prev && prev !== 'sun') {
            appearanceId.match(t.identifier(prev) as any);
            return true;
          }
        }
      }
      return false;
    });

    const collisionAABBId = register('collisionAABB', (node: t.Node) => {
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

      if (!left || !t.isMemberExpression(left)) return false;
      if (left.computed) return false;
      if (!t.isThisExpression(left.object)) return false;
      if (!t.isIdentifier(left.property) || left.property.name !== 'floor') return false;

      if (!right || !t.isMemberExpression(right)) return false;
      if (right.computed) return false;

      const rightProp = right.property;
      const rightObj = right.object;
      if (!t.isMemberExpression(rightObj)) return false;
      if (rightObj.computed) return false;
      if (!t.isIdentifier(rightObj.property) || rightObj.property.name !== 'max') return false;

      const innerObj = rightObj.object;
      if (!t.isMemberExpression(innerObj)) return false;
      if (innerObj.computed) return false;
      if (!t.isThisExpression(innerObj.object)) return false;
      if (!t.isIdentifier(innerObj.property)) return false;

      collisionAABBId.match(innerObj.property as any);
      return true;
    });

    const blockConfigId = register('blockConfig', (node: t.Node) => {
      // helper that checks a MemberExpression of the form X.Y.Z.SKYBOX___SETTING
      function matchMemberChain(expr: t.Node): boolean {
        if (!t.isMemberExpression(expr)) return false;
        const outer = expr as t.MemberExpression; // ... . SKYBOX___SETTING
        if (outer.computed) return false;
        if (!t.isIdentifier(outer.property) || outer.property.name !== 'SKYBOX___SETTING') return false;

        const mid = outer.object;
        if (!t.isMemberExpression(mid) || mid.computed) return false;

        const inner = (mid as t.MemberExpression).object;
        if (!t.isMemberExpression(inner) || inner.computed) return false;
        const innerProp = (inner as t.MemberExpression).property;
        if (!t.isIdentifier(innerProp)) return false;

        // register the obfuscated inner property (e.g., "WmwwMNW")
        blockConfigId.match(innerProp as any);
        return true;
      }

      // 1) If the node itself is a MemberExpression (rare for return form, but keep for completeness)
      if (t.isMemberExpression(node)) {
        return matchMemberChain(node);
      }

      // 2) If the node is a ReturnStatement returning the member chain
      if (t.isReturnStatement(node) && node.argument) {
        if (matchMemberChain(node.argument)) return true;
      }

      // 3) Walk the subtree and look for ReturnStatement nodes (covers functions / blocks)
      let matched = false;
      walk(node, (n) => {
        if (matched) return;
        if (!t.isReturnStatement(n)) return;
        const arg = n.argument;
        if (!arg) return;
        if (matchMemberChain(arg)) matched = true;
      });

      return matched;
    });

    const settingsId = register('settings', (node: t.Node) => {
      function matchMemberChain(expr: t.Node): boolean {
        if (!t.isMemberExpression(expr)) return false;
        const outer = expr as t.MemberExpression; // ... . SKYBOX___SETTING
        if (outer.computed) return false;
        if (!t.isIdentifier(outer.property) || outer.property.name !== 'SKYBOX___SETTING') return false;

        const mid = outer.object;
        if (!t.isMemberExpression(mid) || mid.computed) return false;

        const inner = (mid as t.MemberExpression).object;
        if (!t.isMemberExpression(inner) || inner.computed) return false;

        const midProp = (mid as t.MemberExpression).property;
        if (!t.isIdentifier(midProp)) return false;

        // register the obfuscated middle property (e.g., "wwNmMWn")
        settingsId.match(midProp as any);
        return true;
      }

      // 1) If the node itself is a MemberExpression
      if (t.isMemberExpression(node)) {
        return matchMemberChain(node);
      }

      // 2) If the node is a ReturnStatement returning the member chain
      if (t.isReturnStatement(node) && node.argument) {
        if (matchMemberChain(node.argument)) return true;
      }

      // 3) Walk the subtree and look for ReturnStatement nodes (covers functions / blocks)
      let matched = false;
      walk(node, (n) => {
        if (matched) return;
        if (!t.isReturnStatement(n)) return;
        const arg = n.argument;
        if (!arg) return;
        if (matchMemberChain(arg)) matched = true;
      });

      return matched;
    });

    const playerStateId = register('playerState', (node: t.Node) => {
      const DIVISOR = 0.016666666666666666;

      // helpers to safely read start/end from nodes (typed as optional numbers)
      function getStart(n: t.Node | null | undefined): number | undefined {
        return (n as unknown as { start?: number })?.start;
      }
      function getEnd(n: t.Node | null | undefined): number | undefined {
        return (n as unknown as { end?: number })?.end;
      }

      // 1) find a declarator: var <local> = this.<prop>;
      let candidateProp: t.Identifier | null = null;
      let declaratorNode: t.Node | null = null;
      walk(node, (n) => {
        if (candidateProp) return;
        if (!t.isVariableDeclarator(n)) return;
        if (!t.isIdentifier(n.id)) return;
        const init = n.init;
        if (!init || !t.isMemberExpression(init)) return;
        if (init.computed) return;
        if (!t.isThisExpression(init.object)) return;
        if (!t.isIdentifier(init.property)) return;
        candidateProp = init.property;
        declaratorNode = n;
      });

      if (!candidateProp || !declaratorNode) return false;
      const declStart = getStart(declaratorNode);
      const declEnd = getEnd(declaratorNode);
      if (typeof declStart !== 'number' || typeof declEnd !== 'number') return false;

      // 2) find smallest enclosing container (Program / Block / Function) that contains the declarator
      let container: t.Node | null = null;
      let bestSize = Infinity;
      walk(node, (n) => {
        if (!(t.isProgram(n) || t.isBlockStatement(n) || t.isFunctionExpression(n) || t.isArrowFunctionExpression(n) || t.isFunctionDeclaration(n))) return;
        const nStart = getStart(n);
        const nEnd = getEnd(n);
        if (typeof nStart !== 'number' || typeof nEnd !== 'number') return;
        if (nStart <= declStart && nEnd >= declEnd) {
          const size = nEnd - nStart;
          if (size < bestSize) {
            bestSize = size;
            container = n;
          }
        }
      });
      const searchRoot = container || node;

      // 3) helper: is binary division by the exact constant
      function isDivByConstant(n: t.Node): n is t.BinaryExpression {
        if (!t.isBinaryExpression(n)) return false;
        if (n.operator !== '/') return false;
        const right = n.right;
        if (!t.isNumericLiteral(right)) return false;
        return right.value === DIVISOR || String(right.value) === '0.016666666666666666';
      }

      // 4) search inside the container for a tf update that occurs after the declarator
      let matched = false;
      walk(searchRoot, (n) => {
        if (matched) return;

        // consider ExpressionStatement with assignment: this.tf += ...
        if (t.isExpressionStatement(n) && t.isAssignmentExpression(n.expression)) {
          const a = n.expression;
          if (a.operator === '+=') {
            const left = a.left;
            if (t.isMemberExpression(left) && !left.computed && t.isThisExpression(left.object) && t.isIdentifier(left.property) && left.property.name === 'tf') {
              const right = a.right;
              if (isDivByConstant(right)) {
                const nStart = getStart(n);
                if (typeof nStart === 'number' && nStart > declEnd) {
                  matched = true;
                  return;
                }
              }
            }
          }
        }

        // also handle raw AssignmentExpression nodes (not wrapped)
        if (t.isAssignmentExpression(n)) {
          const a = n;
          if (a.operator === '+=') {
            const left = a.left;
            if (t.isMemberExpression(left) && !left.computed && t.isThisExpression(left.object) && t.isIdentifier(left.property) && left.property.name === 'tf') {
              const right = a.right;
              if (isDivByConstant(right)) {
                const nStart = getStart(n);
                if (typeof nStart === 'number' && nStart > declEnd) {
                  matched = true;
                  return;
                }
              }
            }
          }
        }
      });

      if (matched) {
        playerStateId.match(candidateProp as any);
        return true;
      }

      return false;
    });


    const discovered = new Map<string, string>();

    function tryCapture(node: t.Node) {
      for (const p of patterns) {
        try {
          if (p.predicate(node)) {
            const idCap = p.captureId;
            if (idCap && idCap.current) {
              const name = idCap.current.name;
              if (!discovered.has(p.name)) discovered.set(p.name, name);
            } else {
              logger('error', { message: 'pattern matched but capture empty', pattern: p.name });
            }
          }
        } catch (err) {
          logger('error', { message: 'error while processing node', error: err });
        }
      }
    }

    return {
      AssignmentExpression(path) {
        tryCapture(path.node);
      },
      ExpressionStatement(path) {
        tryCapture(path.node);
      },
      Program: {
        exit(path) {
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
        },
      },
    };
  },
} satisfies Transform;
