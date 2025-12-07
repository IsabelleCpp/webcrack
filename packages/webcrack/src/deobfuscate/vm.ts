import type { NodePath } from '@babel/traverse';
import type { CallExpression } from '@babel/types';
import debug from 'debug';
import { generate } from '../ast-utils';
import type { ArrayRotator } from './array-rotator';
import type { Decoder } from './decoder';
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
      
    const decoderCalleeCode = decoders
      .map((decoder) => generate(decoder.calleePath!.node, generateOptions))
      .join(';\n');

    const decoder_internal_dep = 
    `
      function __DECODE_INTERNAL_DEP__(XXsvM3) {
      return function () {
      var XXsvM3 = new Array(128);
      var biD0GOC;
      var Ah5Bniq;
      biD0GOC = String.fromCodePoint || String.fromCharCode;
      Ah5Bniq = [];
      return function (SrT8Eo) {
        var ix9tW3;
        var dbhTye;
        var WX7bbZ;
        var nXQMoVr;
        dbhTye = undefined;
        WX7bbZ = SrT8Eo.length;
        Ah5Bniq.length = 0;
        for (nXQMoVr = 0; nXQMoVr < WX7bbZ;) {
          dbhTye = SrT8Eo[nXQMoVr++];
          if (dbhTye <= 127) {
            ix9tW3 = dbhTye;
          } else if (dbhTye <= 223) {
            ix9tW3 = (dbhTye & 31) << 6 | SrT8Eo[nXQMoVr++] & 63;
          } else if (dbhTye <= 239) {
            ix9tW3 = (dbhTye & 15) << 12 | (SrT8Eo[nXQMoVr++] & 63) << 6 | SrT8Eo[nXQMoVr++] & 63;
          } else if (String.fromCodePoint) {
            ix9tW3 = (dbhTye & 7) << 18 | (SrT8Eo[nXQMoVr++] & 63) << 12 | (SrT8Eo[nXQMoVr++] & 63) << 6 | SrT8Eo[nXQMoVr++] & 63;
          } else {
            ix9tW3 = 63;
            nXQMoVr += 3;
          }
          Ah5Bniq.push(XXsvM3[ix9tW3] ||= biD0GOC(ix9tW3));
        }
        return Ah5Bniq.join("");
      };
    }()(XXsvM3);
  }
    `
    this.setupCode = [stringArrayCode, rotatorCode, decoderCode, decoderCalleeCode, decoder_internal_dep, stringArray.definition].join(';\n');
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
