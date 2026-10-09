import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**"] },
  ...tseslint.configs.recommended,
  prettierConfig,
  // Anti-corruption layer (see CLAUDE.md / docs/adr/context-map.md): a service
  // must never import another bounded context's code. Reference other contexts
  // by ID, and share event contracts only through packages/ (e.g. @cms/events).
  {
    files: ["**/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["*-service", "*-service/*", "**/*-service/**", "**/apps/**"],
              message:
                "Don't import another bounded context's code. Reference it by ID, or share contracts via packages/ (@cms/events).",
            },
          ],
        },
      ],
    },
  }
);
