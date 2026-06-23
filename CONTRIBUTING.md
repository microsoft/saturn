# Contributing to Saturn

Thank you for your interest in contributing to Saturn! This project welcomes contributions and suggestions.

## Contributor License Agreement (CLA)

Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the
right to, and actually do, grant us the rights to use your contribution. For details, visit
<https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and
decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the
bot. You will only need to do this once across all repos using our CLA.

## Code of Conduct

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Development

Saturn is a TypeScript project driven by the GitHub Copilot CLI. Everything external is shelled out (git, the
Copilot CLI, the Azure DevOps REST APIs), so there are no service-specific build dependencies.

Prerequisites: **Node.js 22+** (the local stores use the built-in `node:sqlite`) and the **GitHub Copilot CLI**
on your `PATH`.

```bash
npm install      # install dependencies
npm run build    # type-check (tsc --noEmit)
npm run lint     # eslint
npm test         # jest
```

See [docs/get-started.md](docs/get-started.md) to run Saturn against your own Azure DevOps repository, and
[docs/architecture.md](docs/architecture.md) for the design.

## Pull requests

- Keep changes focused — one logical change per pull request.
- Add or update tests for behavior changes; `npm test` must pass.
- Make sure `npm run build` and `npm run lint` are clean before opening the PR.
- Follow the existing code style and conventions.

## Reporting issues

- For bugs and feature requests, please open a [GitHub issue](https://github.com/microsoft/saturn/issues).
- For **security vulnerabilities**, do **not** open a public issue — see [SECURITY.md](SECURITY.md) for how to
  report them to the Microsoft Security Response Center (MSRC).
