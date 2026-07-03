#!/usr/bin/env bash
# One-time: deploy the GitHub Actions OIDC role for CI deploys.
#
#   ./deploy/bootstrap-oidc.sh
#
# Auth: locally, set AWS_PROFILE=personal-sso (after `aws sso login
# --sso-session personal-sso`). The GitHub OIDC provider already exists in the
# account (created by bin-builder), so CreateOIDCProvider defaults to 'false'.
#
# Prints the DeployRoleArn — set it as the repo variable AWS_DEPLOY_ROLE_ARN
# (Settings → Secrets and variables → Actions → Variables) for the workflow.
set -euo pipefail

# Load repo-local .env (gitignored) for local runs — e.g. AWS_PROFILE. Values
# already set in the environment take precedence.
load_dotenv() {
  local file="$1" line key val
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    key="${line%%=*}"; key="${key//[[:space:]]/}"
    val="${line#*=}"; val="${val#"${val%%[![:space:]]*}"}"
    [[ -z "$key" ]] && continue
    [[ -n "${!key:-}" ]] && continue
    export "$key=$val"
  done < "$file"
}
load_dotenv "$(dirname "$0")/../.env"

REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK:-home-office-gha-oidc}"
GITHUB_ORG="${GITHUB_ORG:-jroberts64}"
GITHUB_REPO="${GITHUB_REPO:-home-office}"

PROFILE_ARG=()
if [[ -n "${AWS_PROFILE:-}" ]]; then
  PROFILE_ARG=(--profile "$AWS_PROFILE")
fi

cd "$(dirname "$0")/.."

echo "==> Deploying OIDC role stack ($STACK)…"
aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file deploy/github-oidc.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  "${PROFILE_ARG[@]}" --region "$REGION" \
  --parameter-overrides \
    GitHubOrg="$GITHUB_ORG" \
    GitHubRepo="$GITHUB_REPO" \
    CreateOIDCProvider=false

echo "==> Role ARN (set as repo variable AWS_DEPLOY_ROLE_ARN):"
aws cloudformation describe-stacks --stack-name "$STACK" \
  "${PROFILE_ARG[@]}" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" \
  --output text
