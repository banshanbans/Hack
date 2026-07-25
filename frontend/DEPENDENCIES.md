# Web dependency notes

`package.json` and `package-lock.json` pin the React build and test toolchain. Production contains only the browser bundle; Vite, TypeScript, Vitest, jsdom and Testing Library are development dependencies.

| Package group | Purpose | License |
|---|---|---|
| React / React DOM | Component runtime | MIT |
| React Router DOM | Client-only `HashRouter` and route recovery | MIT |
| Vite / React plugin | Build and development proxy | MIT |
| TypeScript | Static type checking | Apache-2.0 |
| Vitest / Testing Library / jsdom | Unit and component tests | MIT |
| Fontsource fonts | Bundled Plus Jakarta Sans and Noto Sans SC | OFL-1.1 |
| Material Symbols font | Bundled interface icons | Apache-2.0 |

The current npm advisory database reports a high-severity React Router advisory for RSC/server-action request handling with no non-vulnerable published `7.x` release. This app uses only the client-side `HashRouter` and does not enable React Router RSC, loaders, actions, SSR, or server-action endpoints, so that vulnerable path is not reachable here. The dependency remains on the newest pinned release and should be upgraded when an upstream fix is published.
