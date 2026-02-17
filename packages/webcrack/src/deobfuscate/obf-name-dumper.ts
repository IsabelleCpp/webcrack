import generate from '@babel/generator';
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

    // -------------------------
    // Original physics pattern
    // -------------------------
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

    // -------------------------------------------------------
    // NEW: sample pattern (robust) for guaranteed detection
    // Accepts both obj.prop and obj["prop"] forms and normalizes
    // -------------------------------------------------------
    const sampleId = m.capture<t.Identifier>(m.identifier());
    const sampleStr = m.capture<t.StringLiteral>(m.stringLiteral());

    // matcher that accepts either non-computed Identifier property or computed StringLiteral property
    const sampleMemberEither = m.matcher<t.MemberExpression>((node) => {
      if (!t.isMemberExpression(node)) return false;
      // non-computed property like obj.prop
      if (!node.computed && t.isIdentifier(node.property)) {
        return sampleId.match(node.property as any);
      }
      // computed property like obj["prop"]
      if (node.computed && t.isStringLiteral(node.property)) {
        return sampleStr.match(node.property as any);
      }
      return false;
    }) as any;

    const sampleBinary = binaryLtSmall(sampleMemberEither);

    patterns.push({
      name: 'sample',
      capture: sampleId, // primary capture is Identifier; sampleStr is handled separately
      predicate(node: t.Node) {
        if (t.isIfStatement(node)) {
          const test = node.test;
          if (sampleBinary.match(test as any)) {
            logger('predicate sample matched on IfStatement test (direct binary)', {});
            return true;
          }
          if (t.isLogicalExpression(test) && test.operator === '&&') {
            if (sampleBinary.match(test.left as any) || sampleBinary.match(test.right as any)) {
              logger('predicate sample matched on IfStatement test (logical &&)', {});
              return true;
            }
          }
          if (contains(test, sampleBinary)) {
            logger('predicate sample matched on IfStatement test (contains binary)', {});
            return true;
          }
        } else {
          if (contains(node, sampleBinary)) {
            logger('predicate sample matched by contains', { nodeType: node.type });
            return true;
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

      // Keep the original BinaryExpression handler but augment it with a direct sample check
      BinaryExpression(path) {
        // Run existing pattern checks (keeps original behavior)
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

        // --- DIRECT sampleBinary check for guaranteed detection while debugging ---
        try {
          if (sampleBinary.match(path.node as any)) {
            // produce source for the matched BinaryExpression using generate directly
            const matchedCode = generate(path.node).code;
            // left side and property source (if left is MemberExpression)
            let leftCode = '';
            let propCode = '';
            const left = path.node.left;
            if (t.isMemberExpression(left)) {
              leftCode = generate(left).code;
              const prop = left.property;
              propCode = prop ? generate(prop).code : '';
            } else {
              leftCode = generate(left).code;
            }

            // prefer Identifier capture if present
            if (sampleId.current && !discovered.has('sample')) {
              discovered.set('sample', sampleId.current.name);
              logger('direct BinaryExpression match captured sample Identifier', { obf: sampleId.current.name, matchedCode, leftCode, propCode });
            } else if (sampleStr.current && !discovered.has('sample')) {
              // normalize string literal capture to its value
              discovered.set('sample', sampleStr.current.value);
              logger('direct BinaryExpression match captured sample StringLiteral', { obf: sampleStr.current.value, matchedCode, leftCode, propCode });
            } else {
              logger('direct BinaryExpression match but no capture available', { matchedCode, leftCode, propCode });
            }
          }
        } catch (err) {
          logger('error during direct sample BinaryExpression check', { error: (err as Error).message });
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
