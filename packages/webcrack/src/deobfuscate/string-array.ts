import type { NodePath } from '@babel/traverse';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import {
  inlineArrayElements,
  isReadonlyObject,
  renameFast,
  undefinedMatcher,
} from '../ast-utils';
const generate = require('@babel/generator').default;

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


export function findStringArray(ast: t.Node): StringArray | undefined {
  let result: StringArray | undefined;

  const functionName = m.capture(m.anyString());
  const arrayIdentifier = m.capture(m.identifier());
  const arrayExpression = m.capture(
    m.arrayExpression(m.arrayOf(m.or(m.stringLiteral(), undefinedMatcher))),
  );

  // getStringArray = function () { return array; };
  const functionAssignment = m.assignmentExpression(
    '=',
    m.identifier(m.fromCapture(functionName)),
    m.functionExpression(
      undefined,
      [],
      m.blockStatement([m.returnStatement(m.fromCapture(arrayIdentifier))]),
    ),
  );

  const variableDeclaration = m.variableDeclaration(undefined, [
    m.variableDeclarator(arrayIdentifier, arrayExpression),
  ]);

  // function getStringArray() { ... }
  const matcher = m.functionDeclaration(
    m.identifier(functionName),
    [],
    m.or(
      // var array = ["hello", "world"];
      // return (getStringArray = function () { return array; })();
      m.blockStatement([
        variableDeclaration,
        m.returnStatement(m.callExpression(functionAssignment)),
      ]),
      // var array = ["hello", "world"];
      // getStringArray = function () { return array; });
      // return getStringArray();
      m.blockStatement([
        variableDeclaration,
        m.expressionStatement(functionAssignment),
        m.returnStatement(m.callExpression(m.identifier(functionName))),
      ]),
    ),
  );

  traverse(ast, {
    // Wrapped string array from later javascript-obfuscator versions
    FunctionDeclaration(path) {
      if (!matcher.match(path.node)) return;

      const arrNode = arrayExpression.current!;
      const length = arrNode.elements.length;
      if (length === 0) return; // require non-empty

      const fnName = functionName.current!;
      const fnBinding = path.scope.getBinding(fnName);
      if (!fnBinding) return;

      const originalName = fnName;
      renameFast(fnBinding, '__STRING_ARRAY__');

      result = {
        path,
        references: fnBinding.referencePaths,
        originalName,
        name: '__STRING_ARRAY__',
        length,
        foundBy: 'function',
      };
      path.stop();
    },

    // Simple string array inlining (only `array[0]`, `array[1]` etc references, no rotating/decoding).
    // May be used by older or different obfuscators
    VariableDeclaration(path) {
      if (!variableDeclaration.match(path.node)) return;

      const arrNode = arrayExpression.current!;
      const length = arrNode.elements.length;
      if (length === 0) return; // require non-empty

      const arrIdName = arrayIdentifier.current!.name;
      const binding = path.scope.getBinding(arrIdName);
      if (!binding) return;

      const memberAccess = m.memberExpression(
        m.fromCapture(arrayIdentifier),
        m.numericLiteral(m.matcher((value) => value < length)),
      );
      if (!binding.referenced || !isReadonlyObject(binding, memberAccess)) return;

      inlineArrayElements(arrNode, binding.referencePaths);
      path.remove();

      result = {
        path: binding.path as NodePath<t.Node>,
        references: binding.referencePaths,
        originalName: arrIdName,
        name: '__STRING_ARRAY__',
        length,
        foundBy: 'variable',
      };
      path.stop();
    },

    // Detect pattern where a function is declared and then invoked with assignments as args,
    // e.g.:
    // function GtfKkR_() { GtfKkR_ = function () {}; }
    // GtfKkR_(c9_wyxu = {}, rPex3CI = ["...","..."]);
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee)) return;

      const fnName = callee.name;
      const fnBinding = path.scope.getBinding(fnName);
      if (!fnBinding || !fnBinding.path.isFunctionDeclaration()) return;

      const argWithArray = path.node.arguments.find((arg) => {
        if (!t.isAssignmentExpression(arg)) return false;
        const right = arg.right;
        if (!t.isArrayExpression(right)) return false;
        return right.elements.length > 0 && right.elements.every(
          (el) =>
            el === null ||
            t.isStringLiteral(el) ||
            (t.isTemplateLiteral(el) && el.quasis.length === 1 && el.expressions.length === 0),
        );
      }) as t.AssignmentExpression | undefined;

      if (!argWithArray) return;
      if (!t.isIdentifier(argWithArray.left)) return;

      const arrayId = argWithArray.left;
      const arr = argWithArray.right as t.ArrayExpression;
      const length = arr.elements.length;
      if (length === 0) return;

      const originalName = arrayId.name;
      const arrayBinding = path.scope.getBinding(arrayId.name);
      if (arrayBinding) renameFast(arrayBinding, '__STRING_ARRAY__');

      // Generate a JS source string for the array expression and build a variable definition
      // that assigns it to __STRING_ARRAY__ (this is what you'll inject into your VM).
      const arrayCode = generate(arr).code; // e.g. '["a","b","c"]' or '[,"a",`b`]'
      const varName = '__STRING_ARRAY__';
      const definitionString = `var ${varName} = ${arrayCode};`;

      result = {
        path: fnBinding.path as NodePath<t.Node>,
        references: arrayBinding ? arrayBinding.referencePaths : [],
        originalName,
        name: varName,
        length,
        foundBy: 'call',
        // string containing the variable definition you can feed into a VM to recreate the array
        definition: definitionString,
      };

      path.stop();
    },

    // NEW: handle standalone assignment or sequence of assignments like:
    // c9_wyxu = {}, rPex3CI = ["...","..."];
    ExpressionStatement(path) {
      const expr = path.node.expression;

      // collect assignment expressions from either a single assignment or a sequence
      const assignments: t.AssignmentExpression[] = [];
      if (t.isAssignmentExpression(expr)) assignments.push(expr);
      else if (t.isSequenceExpression(expr)) {
        for (const e of expr.expressions) {
          if (t.isAssignmentExpression(e)) assignments.push(e);
        }
      } else {
        return;
      }

      // find an assignment whose right side is an array of strings/holes and non-empty
      const arrAssign = assignments.find((a) => {
        const right = a.right;
        if (!t.isArrayExpression(right)) return false;
        return right.elements.length > 0 && right.elements.every(
          (el) =>
            el === null ||
            t.isStringLiteral(el) ||
            (t.isTemplateLiteral(el) && el.quasis.length === 1 && el.expressions.length === 0),
        );
      });

      if (!arrAssign) return;
      if (!t.isIdentifier(arrAssign.left)) return;

      const arrayId = arrAssign.left;
      const arr = arrAssign.right as t.ArrayExpression;
      const length = arr.elements.length;
      if (length === 0) return; // require non-empty

      const originalName = arrayId.name;
      const arrayBinding = path.scope.getBinding(arrayId.name);
      if (arrayBinding) {
        renameFast(arrayBinding, '__STRING_ARRAY__');

        const anchorPath = arrayBinding.path.isVariableDeclarator()
          ? (arrayBinding.path as NodePath<t.Node>)
          : path;

        result = {
          path: anchorPath,
          references: arrayBinding.referencePaths,
          originalName,
          name: '__STRING_ARRAY__',
          length,
          foundBy: 'expression',
        };
      } else {
        // implicit global assignment: no binding available
        result = {
          path,
          references: [],
          originalName,
          name: '__STRING_ARRAY__',
          length,
          foundBy: 'expression',
        };
      }

      path.stop();
    },
  });

  return result;
}
