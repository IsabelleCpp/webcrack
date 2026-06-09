import type { NodePath } from '@babel/traverse';
import type { CallExpression } from '@babel/types';
import debug from 'debug';
import { generate } from '../ast-utils';
import type { ArrayRotator } from './array-rotator';
import type { Decoder } from './decoder';
import type { MapBasedDecoder } from './get-map-decoder';
import type { XorDecoderObject } from './get-xor-decoder';
import type { EncryptedStringMap } from './hex-xor-keyed-map-finder';
import type { StringArray } from './string-array';

export type Sandbox = (code: string) => Promise<unknown>;

export function createNodeSandbox(): Sandbox {
  return async (code: string) => {
    const {
      default: { Isolate },
    } = await import('isolated-vm');
    const isolate = new Isolate();
    const context = await isolate.createContext();
    const result = (await context.eval(code, {
      timeout: 10_000,
      copy: true,
      filename: 'file:///obfuscated.js',
    })) as unknown;
    context.release();
    isolate.dispose();
    return result;
  };
}

export function createBrowserSandbox(): Sandbox {
  return () => {
    // TODO: use sandybox (not available in web workers though)
    throw new Error('Custom Sandbox implementation required.');
  };
}

export class VMDecoder {
  decoders: Decoder[];
  private setupCode: string;
  private sandbox: Sandbox;

  constructor(
    sandbox: Sandbox,
    stringArray: StringArray,
    decoders: Decoder[],
    rotator?: ArrayRotator,
  ) {
    this.sandbox = sandbox;
    this.decoders = decoders;

    // Generate as compact to bypass the self defense
    // (which tests someFunction.toString against a regex)
    const generateOptions = {
      compact: true,
      shouldPrintComment: () => false,
    };
    const stringArrayCode = generate(stringArray.path.node, generateOptions);
    const rotatorCode = rotator ? generate(rotator.node, generateOptions) : '';
    const decoderCode = decoders
      .map((decoder) => generate(decoder.path.node, generateOptions))
      .join(';\n');

    this.setupCode = [stringArrayCode, rotatorCode, decoderCode].join(';\n');
  }

  async decode(calls: NodePath<CallExpression>[]): Promise<unknown[]> {
    const code = `(() => {
      ${this.setupCode}
      return [${calls.join(',')}]
    })()`;

    try {
      const result = await this.sandbox(code);
      return result as unknown[];
    } catch (error) {
      debug('webcrack:deobfuscate')('vm code:', code);
      if (
        error instanceof Error &&
        (error.message.includes('undefined symbol') ||
          error.message.includes('Segmentation fault'))
      ) {
        throw new Error(
          'isolated-vm version mismatch. Check https://webcrack.netlify.app/docs/guide/common-errors.html#isolated-vm',
          { cause: error },
        );
      }
      throw error;
    }
  }
}

export class VMMapEvaluator {
  decoders: MapBasedDecoder[];
  private setupCode: string;
  private sandbox: Sandbox;

  constructor(sandbox: Sandbox, decoders: MapBasedDecoder[], encryptedStringMap: EncryptedStringMap) {
    this.sandbox = sandbox;
    this.decoders = decoders;

    const generateOptions = {
      compact: true,
      shouldPrintComment: () => false,
    };

    const encryptedStringMapCode = generate(encryptedStringMap.mapPath!.node, generateOptions);
    const encryptedStringCacheMapCode = generate(encryptedStringMap.cachePath!.node, generateOptions);
    const decoderCode = decoders
      .map((d) => {
        try {
          return generate(d.path.node, generateOptions);
        } catch {
          return '';
        }
      })
      .filter(Boolean)
      .join(';\n');

    this.setupCode = [encryptedStringMapCode, encryptedStringCacheMapCode, decoderCode].join(';\n');
  }

  /**
   * Evaluate the provided call expressions inside the sandbox and return results.
   *
   * `calls` should be NodePath<CallExpression>[] pointing at the call expressions
   * you want to evaluate. The method will generate source for each call expression
   * and evaluate them as an array expression inside the sandbox.
   */
  async decode(calls: NodePath<CallExpression>[]): Promise<unknown[]> {
    const generateOptions = {
      compact: true,
      shouldPrintComment: () => false,
    };

    const callSources = calls.map((c) => generate(c.node, generateOptions));

    const code = `(() => {
      ${this.setupCode ? `  ${this.setupCode}\n` : ''}
        return [${callSources.join(',')}];
    })()`;

    try {
      const result = await this.sandbox(code);
      return (result as unknown[]) || [];
    } catch (error) {
      debug('webcrack:deobfuscate')('vm code:', code);
      if (
        error instanceof Error &&
        (error.message.includes('undefined symbol') || error.message.includes('Segmentation fault'))
      ) {
        throw new Error(
          'isolated-vm version mismatch. Check https://webcrack.netlify.app/docs/guide/common-errors.html#isolated-vm',
          { cause: error },
        );
      }
      throw error;
    }
  }
}

export class VMXorEvaluator {
  decoders: XorDecoderObject[];
  private setupCode: string;
  private sandbox: Sandbox;

  constructor(sandbox: Sandbox, decoders: XorDecoderObject[]) {
    this.sandbox = sandbox;
    this.decoders = decoders;

    const generateOptions = {
      compact: true,
      shouldPrintComment: () => false,
    };

    const decoderCode = decoders
      .map((d) => {
        try {
          return generate(d.path.node, generateOptions);
        } catch {
          return '';
        }
      })
      .filter(Boolean)
      .join(';\n');

    this.setupCode = [decoderCode].join(';\n');
  }

  /**
   * Evaluate the provided call expressions inside the sandbox and return results.
   *
   * `calls` should be NodePath<CallExpression>[] pointing at the call expressions
   * you want to evaluate. The method will generate source for each call expression
   * and evaluate them as an array expression inside the sandbox.
   */
  async decode(calls: NodePath<CallExpression>[]): Promise<unknown[]> {
    const generateOptions = {
      compact: true,
      shouldPrintComment: () => false,
    };

    const callSources = calls.map((c) => generate(c.node, generateOptions));

    const code = `(() => {
      ${this.setupCode ? `  ${this.setupCode}\n` : ''}
        return [${callSources.join(',')}];
    })()`;

    try {
      const result = await this.sandbox(code);
      return (result as unknown[]) || [];
    } catch (error) {
      debug('webcrack:deobfuscate')('vm code:', code);
      if (
        error instanceof Error &&
        (error.message.includes('undefined symbol') || error.message.includes('Segmentation fault'))
      ) {
        throw new Error(
          'isolated-vm version mismatch. Check https://webcrack.netlify.app/docs/guide/common-errors.html#isolated-vm',
          { cause: error },
        );
      }
      throw error;
    }
  }
}