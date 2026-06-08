import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
    globalIgnores([
        "node_modules",
        "dist",
        "tools",
        "esbuild.config.mjs",
        "version-bump.mjs",
        "versions.json",
        "main.js",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "eslint.config.mjs",
    ]),
    {
        languageOptions: {
            globals: { ...globals.browser },
            parserOptions: {
                projectService: {
                    allowDefaultProject: ["eslint.config.mjs", "manifest.json"],
                },
                tsconfigRootDir: import.meta.dirname,
                extraFileExtensions: [".json"],
            },
        },
    },
    ...obsidianmd.configs.recommended,
    {
        rules: {
            "obsidianmd/ui/sentence-case": [
                "error",
                {
                    enforceCamelCaseLower: true,
                    brands: ["arXiv", "OpenAlex", "VPN", "VPNs"],
                },
            ],
        },
    },
);
