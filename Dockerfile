# Saturn dashboard + review agent, containerized for hosting behind Azure AD Easy Auth
# (App Service or Container Apps). Easy Auth injects the `x-ms-client-principal-name` header that Saturn
# reads (with SATURN_BEHIND_PROXY=true) for per-user identity and owner gating.
#
# This is a STARTING SCAFFOLD. The dashboard runs out of the box, but the *review loop* needs credentials
# that must be provided at deploy time (Saturn shells out to all three):
#   - GitHub Copilot CLI (the review model): provide a token so `copilot` runs headlessly - interactive
#     `/login` is not possible in a container.
#   - Azure DevOps access: assign the app a managed identity with access to the target repo (Saturn mints
#     ADO tokens via the Azure CLI), or supply a PAT-based git credential.
#   - Persist /root/.saturn (reviews/feedback/totals) via a mounted volume (e.g. Azure Files).

FROM node:20-bookworm-slim

# git (clone the target repo) + Azure CLI (mint ADO tokens) + the GitHub Copilot CLI (the review model).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && curl -sL https://aka.ms/InstallAzureCLIDeb | bash \
 && npm install -g @github/copilot \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Behind Easy Auth the dashboard is fronted by a proxy that forwards from localhost, so loopback must not be
# trusted as the owner - identity comes from the injected x-ms-client-principal-name header instead.
ENV SATURN_BEHIND_PROXY=true
EXPOSE 6789

# Provide SATURN_ADO_* / SATURN_OWNER / SATURN_FEEDBACK_URL at deploy time (env vars or a mounted .env).
CMD ["npx", "tsx", "src/saturnDashboard.ts"]
