import { createFromRoot } from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderJavaScriptVisitor } from "@codama/renderers";
import path from "path";
import { promises as fs } from "fs";

const loadAnchorIDL = async () => {
  const basePath = path.join("target", "idl");
  const dirPath = path.join(basePath);

  try {
    const files = await fs.readdir(dirPath);
    const jsonFiles = files.filter((file) => file.endsWith(".json"));

    if (!jsonFiles.length) {
      throw new Error(`No JSON files found in ${dirPath}`);
    }

    if (jsonFiles.length > 1) {
      throw new Error(
        `Multiple JSON files found in ${dirPath}. Please specify which one to use.`
      );
    }

    const filePath = path.join(dirPath, jsonFiles[0]);
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Failed to load IDL: ${dirPath} does not exist`);
    }
    throw error;
  }
};

const idl = await loadAnchorIDL();

const codama = createFromRoot(rootNodeFromAnchor(idl));

const generatedPath = path.join("dist", "election-client");
codama.accept(renderJavaScriptVisitor(generatedPath));

console.log(`✅ Codama client generated at ${generatedPath}`);
