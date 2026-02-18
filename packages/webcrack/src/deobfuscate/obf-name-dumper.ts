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

    const modulesId = m.capture<t.Identifier>(m.identifier());
    const thisMemberMatcher = m.matcher<t.MemberExpression>((node) => {
      if (!t.isMemberExpression(node)) return false;
      if (!t.isThisExpression(node.object)) return false;
      if (!node.computed && t.isIdentifier(node.property)) {
        return modulesId.match(node.property as any);
      }
      return false;
    }) as any;

    const prototypeLeftMatcher = m.matcher<t.MemberExpression>((node) => {
      if (!t.isMemberExpression(node)) return false;
      if (!t.isMemberExpression(node.object)) return false;
      const inner = node.object;
      if (inner.computed || !t.isIdentifier(inner.property)) return false;
      if (inner.property.name !== 'prototype') return false;
      if (!t.isIdentifier(node.property)) return false;
      return true;
    }) as any;

    addPattern('_modules', modulesId, (node: t.Node) => {
      if (t.isAssignmentExpression(node)) {
        if (prototypeLeftMatcher.match(node.left as any)) {
          const right = node.right;
          if (t.isFunctionExpression(right) || t.isArrowFunctionExpression(right)) {
            return contains(right.body, thisMemberMatcher);
          }
        }
      }
      if (t.isExpressionStatement(node) && t.isAssignmentExpression(node.expression)) {
        const ae = node.expression as t.AssignmentExpression;
        if (prototypeLeftMatcher.match(ae.left as any)) {
          const right = ae.right;
          if (t.isFunctionExpression(right) || t.isArrowFunctionExpression(right)) {
            return contains(right.body, thisMemberMatcher);
          }
        }
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
                if (!discovered.has(p.name)) discovered.set(p.name, name);
              }
            }
          }
        } catch { }
      },

      ExpressionStatement(path) {
        try {
          for (const p of patterns) {
            if (p.predicate(path.node)) {
              const idCap = p.captureId;
              if (idCap && idCap.current) {
                const name = idCap.current.name;
                if (!discovered.has(p.name)) discovered.set(p.name, name);
              }
            }
          }
        } catch { }
      },

      Program: {
        exit(path) {
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
