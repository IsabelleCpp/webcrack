import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import debug from 'debug';
import type { Transform } from '../ast-utils';

const logger = debug('webcrack:obf-name-dumper');

type PatternDef = {
  name: string;
  capture: m.CapturedMatcher<t.Identifier>;
  predicate: (node: t.Node) => boolean;
};

function memberCapture(idCap: m.CapturedMatcher<t.Identifier>): m.Matcher<t.MemberExpression> {
  // cast to loosen matcher generics so it can be used against Expression nodes
  return m.memberExpression(m.anything() as unknown as m.Matcher<t.Expression>, m.fromCapture(idCap) as any, false) as any;
}

function binaryLtSmall(leftMatcher: m.Matcher<t.Expression>): m.Matcher<t.BinaryExpression> {
  return m.matcher<t.BinaryExpression>((node) => {
    if (!t.isBinaryExpression(node)) return false;
    if (node.operator !== '<') return false;
    if (!t.isNumericLiteral(node.right)) return false;
    if (node.right.value >= 1) return false;
    return leftMatcher.match(node.left as any);
  }) as any;
}

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
    const patterns: PatternDef[] = [];

    const physicsId = m.capture<t.Identifier>(m.identifier());
    const physicsMember = memberCapture(physicsId);
    const physicsBinary = binaryLtSmall(physicsMember);

    patterns.push({
      name: 'physics',
      capture: physicsId,
      predicate(node: t.Node) {
        if (!t.isIfStatement(node)) return false;
        const test = node.test;
        if (physicsBinary.match(test as any)) {
          logger('predicate physics matched on IfStatement test (direct binary)', { nodeType: node.type });
          return true;
        }
        if (t.isLogicalExpression(test) && test.operator === '&&') {
          if (physicsBinary.match(test.left as any) || physicsBinary.match(test.right as any)) {
            logger('predicate physics matched on IfStatement test (logical &&)', { nodeType: node.type });
            return true;
          }
        }
        if (contains(test, physicsBinary)) {
          logger('predicate physics matched on IfStatement test (contains binary)', { nodeType: node.type });
          return true;
        }
        if (t.isBlockStatement(node.consequent)) {
          for (const stmt of node.consequent.body) {
            if (t.isIfStatement(stmt) && contains(stmt.test, physicsBinary)) {
              logger('predicate physics matched inside consequent nested IfStatement', { parentType: node.type });
              return true;
            }
            if (contains(stmt, physicsBinary)) {
              logger('predicate physics matched inside consequent statement (contains)', { parentType: node.type, stmtType: stmt.type });
              return true;
            }
          }
        }
        return false;
      },
    });

    const discovered = new Map<string, string>();

    return {
      IfStatement: {
        enter(path) {
          for (const p of patterns) {
            try {
              if (p.predicate(path.node)) {
                const id = p.capture.current;
                logger('pattern predicate true', { pattern: p.name, captured: id ? id.name : null });
                if (id && !discovered.has(p.name)) {
                  discovered.set(p.name, id.name);
                  logger('discovered new obfuscated name', { readable: p.name, obf: id.name });
                } else if (id) {
                  logger('already discovered pattern, skipping set', { pattern: p.name, existing: discovered.get(p.name) });
                }
              }
            } catch (err) {
              logger('error while evaluating predicate for IfStatement', { pattern: p.name, error: (err as Error).message });
            }
          }
        },
      },

      BinaryExpression(path) {
        for (const p of patterns) {
          try {
            if (p.predicate(path.parent as any)) {
              const id = p.capture.current;
              logger('pattern predicate true on BinaryExpression parent', { pattern: p.name, captured: id ? id.name : null });
              if (id && !discovered.has(p.name)) {
                discovered.set(p.name, id.name);
                logger('discovered new obfuscated name from BinaryExpression', { readable: p.name, obf: id.name });
              } else if (id) {
                logger('already discovered pattern from BinaryExpression, skipping set', { pattern: p.name, existing: discovered.get(p.name) });
              }
            }
          } catch (err) {
            logger('error while evaluating predicate for BinaryExpression', { pattern: p.name, error: (err as Error).message });
          }
        }
      },

      Program: {
        exit(path) {
          logger('program exit, discovered map size', { size: discovered.size });
          if (discovered.size === 0) {
            logger('no obfuscated names discovered, exiting without changes');
            return;
          }
          const props: t.ObjectProperty[] = [];
          for (const [readable, obf] of discovered) {
            logger('adding property to __obf_names object', { readable, obf });
            props.push(t.objectProperty(t.identifier(readable), t.stringLiteral(obf)));
          }
          const decl = t.variableDeclaration('const', [
            t.variableDeclarator(t.identifier('__obf_names'), t.objectExpression(props)),
          ]);
          path.node.body.push(decl);
          logger('appended __obf_names declaration to program body', { declCount: props.length });
          // @ts-ignore
          if (typeof this.changes === 'number') {
            this.changes += 1;
            logger('incremented changes counter', { newChanges: this.changes });
          }
        },
      },
    };
  },
} satisfies Transform;
