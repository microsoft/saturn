// Provides deterministic Azure DevOps configuration for unit tests, so config.ts (which reads these from
// the environment / a .env file) resolves without requiring a real .env to be present in CI. Real env vars
// and a local .env still take precedence because we only fill values that are not already set.
process.env.SATURN_ADO_HOST = process.env.SATURN_ADO_HOST || "dev.azure.com";
process.env.SATURN_ADO_ORG = process.env.SATURN_ADO_ORG || "test-org";
process.env.SATURN_ADO_PROJECT =
  process.env.SATURN_ADO_PROJECT || "test-project";
process.env.SATURN_ADO_REPO_ID =
  process.env.SATURN_ADO_REPO_ID || "test-repo-id";
process.env.SATURN_ADO_REPO_NAME =
  process.env.SATURN_ADO_REPO_NAME || "test-repo";
