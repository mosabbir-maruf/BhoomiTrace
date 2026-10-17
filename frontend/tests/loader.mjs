import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (specifier.startsWith("@/")) {
      const rel = specifier.slice(2)
      const srcDir = path.resolve(process.cwd(), "src")
      for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        const candidate = path.resolve(srcDir, rel + ext)
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return {
            url: pathToFileURL(candidate).href,
            shortCircuit: true,
          }
        }
      }
    }

    if (context.parentURL) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL))
      for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        const candidate = path.resolve(parentDir, specifier + ext)
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return {
            url: pathToFileURL(candidate).href,
            shortCircuit: true,
          }
        }
      }
    }
    throw err
  }
}
