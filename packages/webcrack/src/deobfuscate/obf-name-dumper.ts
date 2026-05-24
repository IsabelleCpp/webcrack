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

/* Lightweight contains wrapper used by many predicates */
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

/* Generic AST walker that visits children in a predictable way.
   Keeps the original behavior but is easier to read and extend. */
function walk(node: t.Node | null | undefined, cb: (n: t.Node) => void) {
  if (!node) return;
  cb(node);

  // Common node families handled explicitly for clarity and speed
  if (t.isProgram(node) || t.isBlockStatement(node)) {
    for (const s of node.body) walk(s, cb);
    return;
  }

  if (t.isExpressionStatement(node)) {
    walk(node.expression, cb);
    return;
  }

  if (t.isAssignmentExpression(node)) {
    walk(node.left, cb);
    walk(node.right, cb);
    return;
  }

  if (t.isCallExpression(node)) {
    walk(node.callee as any, cb);
    for (const a of node.arguments) walk(a as any, cb);
    return;
  }

  if (t.isMemberExpression(node)) {
    walk(node.object as any, cb);
    walk(node.property as any, cb);
    return;
  }

  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
    walk(node.body as any, cb);
    for (const p of node.params) walk(p as any, cb);
    return;
  }

  if (t.isReturnStatement(node)) {
    walk(node.argument as any, cb);
    return;
  }

  if (t.isVariableDeclaration(node)) {
    for (const d of node.declarations) walk(d as any, cb);
    return;
  }

  if (t.isVariableDeclarator(node)) {
    walk(node.id as any, cb);
    walk(node.init as any, cb);
    return;
  }

  if (t.isIfStatement(node)) {
    walk(node.test as any, cb);
    walk(node.consequent as any, cb);
    walk(node.alternate as any, cb);
    return;
  }

  if (t.isUnaryExpression(node) || t.isBinaryExpression(node) || t.isLogicalExpression(node)) {
    // binary: left/right, unary: argument
    // use safe access to support mixed shapes
    // @ts-ignore
    walk((node as any).left ?? (node as any).argument, cb);
    // @ts-ignore
    walk((node as any).right ?? null, cb);
    return;
  }

  if (t.isObjectExpression(node)) {
    for (const p of node.properties) {
      // @ts-ignore
      walk((p as any).value, cb);
    }
    return;
  }

  if (t.isArrayExpression(node)) {
    for (const e of node.elements) walk(e as any, cb);
    return;
  }

  // Fallback: iterate object keys and walk any child nodes
  for (const key of Object.keys(node as any)) {
    const val = (node as any)[key];
    if (Array.isArray(val)) {
      for (const el of val) if (el && typeof el.type === 'string') walk(el, cb);
    } else if (val && typeof val.type === 'string') {
      walk(val, cb);
    }
  }
}

/* Helpers used by multiple patterns */

// Checks for MemberExpression of the form X.prototype.Y (non-computed)
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

function getStart(n: t.Node | null | undefined): number | undefined {
  return (n as unknown as { start?: number })?.start;
}
function getEnd(n: t.Node | null | undefined): number | undefined {
  return (n as unknown as { end?: number })?.end;
}

/* Find the smallest enclosing Program/Block/Function that contains a given range */
function findSmallestContainer(root: t.Node, start: number, end: number): t.Node | null {
  let container: t.Node | null = null;
  let bestSize = Infinity;
  walk(root, (n) => {
    if (!(t.isProgram(n) || t.isBlockStatement(n) || t.isFunctionExpression(n) || t.isArrowFunctionExpression(n) || t.isFunctionDeclaration(n))) return;
    const nStart = getStart(n);
    const nEnd = getEnd(n);
    if (typeof nStart !== 'number' || typeof nEnd !== 'number') return;
    if (nStart <= start && nEnd >= end) {
      const size = nEnd - nStart;
      if (size < bestSize) {
        bestSize = size;
        container = n;
      }
    }
  });
  return container;
}

/* Generic helper to find a declarator of the form var <id> = this.<...>.<prop> */
function findDeclaratorChain(root: t.Node) {
  let innerProp: t.Identifier | null = null;
  let outerProp: t.Identifier | null = null;
  let declaratorNode: t.Node | null = null;

  walk(root, (n) => {
    if (innerProp && outerProp) return;
    if (!t.isVariableDeclarator(n)) return;
    if (!t.isIdentifier(n.id)) return;
    const init = n.init;
    if (!init || !t.isMemberExpression(init)) return;
    if (init.computed) return;

    const outerME = init;
    const outer = outerME.property;
    const innerME = outerME.object;
    if (!t.isMemberExpression(innerME)) return;
    if (innerME.computed) return;
    const innerObj = innerME.object;
    const inner = innerME.property;

    if (!t.isThisExpression(innerObj)) return;
    if (!t.isIdentifier(inner) || !t.isIdentifier(outer)) return;

    innerProp = inner;
    outerProp = outer;
    declaratorNode = n;
  });

  return { innerProp, outerProp, declaratorNode };
}

/* Check for division by a specific numeric constant */
function isDivByConstant(n: t.Node, value: number) {
  if (!t.isBinaryExpression(n)) return false;
  if (n.operator !== '/') return false;
  const right = n.right;
  if (!t.isNumericLiteral(right)) return false;
  return right.value === value || String(right.value) === String(value);
}

/* Search for a this.tf += <expr> / DIVISOR update that occurs after a given position */
function findTfUpdateAfter(root: t.Node, afterPos: number, divisor: number) {
  let found = false;
  walk(root, (n) => {
    if (found) return;
    // ExpressionStatement wrapper
    if (t.isExpressionStatement(n) && t.isAssignmentExpression(n.expression)) {
      const a = n.expression;
      if (a.operator === '+=') {
        const left = a.left;
        if (t.isMemberExpression(left) && !left.computed && t.isThisExpression(left.object) && t.isIdentifier(left.property) && left.property.name === 'tf') {
          if (isDivByConstant(a.right, divisor)) {
            const nStart = getStart(n);
            if (typeof nStart === 'number' && nStart > afterPos) found = true;
          }
        }
      }
    }
    // raw assignment expression
    if (t.isAssignmentExpression(n) && n.operator === '+=') {
      const left = n.left;
      if (t.isMemberExpression(left) && !left.computed && t.isThisExpression(left.object) && t.isIdentifier(left.property) && left.property.name === 'tf') {
        if (isDivByConstant(n.right, divisor)) {
          const nStart = getStart(n);
          if (typeof nStart === 'number' && nStart > afterPos) found = true;
        }
      }
    }
  });
  return found;
}

/* Pattern registration and definitions */
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

    // Reusable pattern: __vue__
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

    // _modules pattern (kept logic but clearer helpers)
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

    // _data pattern (kept logic but clearer helpers)
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

    // appearance_obf pattern (unchanged logic but clearer)
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

    // collisionAABB pattern (kept but simplified variable names)
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

    // blockConfig and settings share a similar member-chain pattern; extract a small helper
    function matchMemberChainForSkybox(expr: t.Node, capture: m.CapturedMatcher<t.Identifier>, which: 'inner' | 'mid') {
      if (!t.isMemberExpression(expr)) return false;
      const outer = expr as t.MemberExpression;
      if (outer.computed) return false;
      if (!t.isIdentifier(outer.property) || outer.property.name !== 'SKYBOX___SETTING') return false;

      const mid = outer.object;
      if (!t.isMemberExpression(mid) || mid.computed) return false;

      const inner = (mid as t.MemberExpression).object;
      if (!t.isMemberExpression(inner) || inner.computed) return false;

      if (which === 'inner') {
        const innerProp = (inner as t.MemberExpression).property;
        if (!t.isIdentifier(innerProp)) return false;
        capture.match(innerProp as any);
        return true;
      } else {
        const midProp = (mid as t.MemberExpression).property;
        if (!t.isIdentifier(midProp)) return false;
        capture.match(midProp as any);
        return true;
      }
    }

    const blockConfigId = register('blockConfig', (node: t.Node) => {
      if (t.isMemberExpression(node)) return matchMemberChainForSkybox(node, blockConfigId, 'inner');
      if (t.isReturnStatement(node) && node.argument) return matchMemberChainForSkybox(node.argument, blockConfigId, 'inner');

      let matched = false;
      walk(node, (n) => {
        if (matched) return;
        if (!t.isReturnStatement(n)) return;
        const arg = n.argument;
        if (!arg) return;
        if (matchMemberChainForSkybox(arg, blockConfigId, 'inner')) matched = true;
      });
      return matched;
    });

    const settingsId = register('settings', (node: t.Node) => {
      if (t.isMemberExpression(node)) return matchMemberChainForSkybox(node, settingsId, 'mid');
      if (t.isReturnStatement(node) && node.argument) return matchMemberChainForSkybox(node.argument, settingsId, 'mid');

      let matched = false;
      walk(node, (n) => {
        if (matched) return;
        if (!t.isReturnStatement(n)) return;
        const arg = n.argument;
        if (!arg) return;
        if (matchMemberChainForSkybox(arg, settingsId, 'mid')) matched = true;
      });
      return matched;
    });

    // playerState, weaponInventory, currentWeaponSlot share a similar pattern:
    //  - find declarator var <local> = this.<inner>.<outer>;
    //  - find a this.tf += ... / DIVISOR update after the declarator
    // We implement a small factory to avoid duplication.
    function makeTfBasedPattern(name: string, captureWhich: 'inner' | 'outer') {
      const cap = register(name, (node: t.Node) => {
        const DIVISOR = 0.016666666666666666;
        const { innerProp, outerProp, declaratorNode } = findDeclaratorChain(node);
        if (!innerProp || !outerProp || !declaratorNode) return false;
        const declStart = getStart(declaratorNode);
        const declEnd = getEnd(declaratorNode);
        if (typeof declStart !== 'number' || typeof declEnd !== 'number') return false;

        const container = findSmallestContainer(node, declStart, declEnd) || node;
        const matched = findTfUpdateAfter(container, declEnd, DIVISOR);
        if (!matched) return false;

        if (captureWhich === 'inner') {
          cap.match(innerProp as any);
        } else {
          cap.match(outerProp as any);
        }
        return true;
      });
      return cap;
    }

    // Register the three similar patterns
    makeTfBasedPattern('playerState', 'inner'); // original captured candidateProp
    makeTfBasedPattern('weaponInventory', 'inner'); // inner property
    makeTfBasedPattern('currentWeaponSlot', 'outer'); // outer property

    // Replace the previous setAmmoId predicate with this version
    const setAmmoId = register('setAmmo', (node: t.Node) => {
      const DIVISOR = 0.016666666666666666;
      let foundInnerProp: string | null = null;
      let foundCommitSecond: string | null = null;

      // 1) find a declarator or assignment that yields this.<inner>.<outer>
      walk(node, (n) => {
        if (foundInnerProp) return;
        // var la = this.WwMWNwm; OR var lb = this.WwNMWn.WwWMNmn;
        if (t.isVariableDeclarator(n) && t.isIdentifier(n.id) && n.init && t.isMemberExpression(n.init)) {
          const outerME = n.init;
          if (!outerME.computed && t.isMemberExpression(outerME.object) && !outerME.object.computed) {
            const innerME = outerME.object;
            if (t.isThisExpression(innerME.object) && t.isIdentifier(innerME.property)) {
              foundInnerProp = innerME.property.name;
            }
          } else if (!outerME.computed && t.isThisExpression(outerME.object) && t.isIdentifier(outerME.property)) {
            // handle var la = this.WwMWNwm;
            foundInnerProp = outerME.property.name;
          }
        }

        // also accept simple assignment: la = this.X.Y
        if (!foundInnerProp && t.isAssignmentExpression(n) && t.isMemberExpression(n.right)) {
          const right = n.right;
          if (!right.computed && t.isMemberExpression(right.object) && !right.object.computed) {
            const innerME = right.object;
            if (t.isThisExpression(innerME.object) && t.isIdentifier(innerME.property)) {
              foundInnerProp = innerME.property.name;
            }
          } else if (!right.computed && t.isThisExpression(right.object) && t.isIdentifier(right.property)) {
            foundInnerProp = right.property.name;
          }
        }
      });

      if (!foundInnerProp) return false;

      // 2) ensure there's a this.tf += <something> / DIVISOR somewhere (same container)
      // find declarator node to compute position; fallback to node start/end if not available
      let declNode: t.Node | null = null;
      walk(node, (n) => {
        if (declNode) return;
        if (t.isVariableDeclarator(n) && t.isIdentifier(n.id)) {
          const init = n.init;
          if (init && t.isMemberExpression(init) && t.isThisExpression((init.object as any).object ?? init.object)) {
            declNode = n;
          }
        }
      });

      const declEnd = getEnd(declNode) ?? -Infinity;
      const container = declNode && typeof getStart(declNode) === 'number' && typeof getEnd(declNode) === 'number'
        ? (findSmallestContainer(node, getStart(declNode)!, getEnd(declNode)!) || node)
        : node;

      const hasTfDiv = findTfUpdateAfter(container, declEnd, DIVISOR);
      if (!hasTfDiv) return false;

      // 3) find a commit("X/Y", ...) call and capture Y (second segment)
      walk(node, (n) => {
        if (foundCommitSecond) return;
        if (!t.isCallExpression(n)) return;
        const callee = n.callee;
        if (!t.isMemberExpression(callee)) return;
        if (!t.isIdentifier(callee.property) || callee.property.name !== 'commit') return;
        const args = n.arguments;
        if (!args || args.length === 0) return;
        const first = args[0];
        if (!t.isStringLiteral(first)) return;
        const parts = first.value.split('/');
        if (parts.length < 2) return;
        const second = parts[1];
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(second)) {
          foundCommitSecond = second;
        }
      });

      if (!foundCommitSecond) return false;

      // commit the captured second segment as the obfuscated name
      setAmmoId.match(t.identifier(foundCommitSecond) as any);
      return true;
    });

    // weaponSlots pattern: capture the property name used as alias.<prop>[index].nested
    const weaponSlotsId = register('weaponSlots', (node: t.Node) => {
      // 1) find alias declarator: var <alias> = this.<...>;
      let aliasName: string | null = null;
      let declaratorNode: t.Node | null = null;

      walk(node, (n) => {
        if (aliasName) return;
        if (!t.isVariableDeclarator(n)) return;
        if (!t.isIdentifier(n.id)) return;
        const init = n.init;
        if (!init || !t.isMemberExpression(init)) return;
        if (init.computed) return;

        // handle var la = this.X  OR var la = this.X.Y
        if (t.isThisExpression(init.object)) {
          aliasName = n.id.name;
          declaratorNode = n;
          return;
        }
        if (t.isMemberExpression(init.object) && t.isThisExpression((init.object as t.MemberExpression).object)) {
          aliasName = n.id.name;
          declaratorNode = n;
          return;
        }
      });

      if (!aliasName || !declaratorNode) return false;

      // 2) restrict search to smallest container around the declarator
      const declStart = getStart(declaratorNode);
      const declEnd = getEnd(declaratorNode);
      const searchRoot = (typeof declStart === 'number' && typeof declEnd === 'number')
        ? (findSmallestContainer(node, declStart, declEnd) || node)
        : node;

      // 3) look for alias.<prop>[index].<nested> (assignment or read)
      //    require: outermost is MemberExpression with non-computed property (nested),
      //    its object is a computed MemberExpression (array access),
      //    and that object's object is a MemberExpression of form alias.<prop>
      let foundProp: t.Identifier | null = null;
      walk(searchRoot, (n) => {
        if (foundProp) return;

        if (!t.isMemberExpression(n)) return;
        const outer = n; // expected: (alias.prop)[index].nested  -> outer.property is nested
        if (outer.computed) return; // nested must be non-computed (identifier)
        if (!t.isIdentifier(outer.property)) return;

        const maybeArrayAccess = outer.object;
        if (!t.isMemberExpression(maybeArrayAccess) || !maybeArrayAccess.computed) return; // must be computed array access

        const arrayObj = maybeArrayAccess.object; // expected alias.prop
        if (!t.isMemberExpression(arrayObj) || arrayObj.computed) return;
        const obj = arrayObj.object;
        const prop = arrayObj.property;
        if (!t.isIdentifier(prop)) return;

        // obj should be the alias identifier
        if (t.isIdentifier(obj) && obj.name === aliasName) {
          foundProp = prop;
          return;
        }

        // also accept alias nested one level deeper: alias.someObj.prop[index].nested
        // walk up one more level if needed
        if (t.isMemberExpression(obj) && t.isIdentifier((obj as t.MemberExpression).object) && ((obj as t.MemberExpression).object as t.Identifier).name === aliasName) {
          const deeperProp = (obj as t.MemberExpression).property;
          if (t.isIdentifier(deeperProp)) {
            foundProp = deeperProp;
            return;
          }
        }
      });

      if (!foundProp) return false;

      weaponSlotsId.match(foundProp as any);
      return true;
    });

    /* Capture results and emit at Program exit */
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
