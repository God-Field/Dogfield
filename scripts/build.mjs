import {build} from 'esbuild';
await build({entryPoints:['src/main.ts'],outfile:'dist/main.dart.js',bundle:true,format:'iife',platform:'browser',target:'es2022',sourcemap:'inline',legalComments:'none',minify:false});
