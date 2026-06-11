/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  transform: {
    "^.+\\.ts$": [
      "@swc/jest",
      { jsc: { parser: { syntax: "typescript" }, target: "es2022" } },
    ],
  },
  cacheDirectory: "<rootDir>/.jest-cache",
};
