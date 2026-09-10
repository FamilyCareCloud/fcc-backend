"""Run once from an authorized AWS CloudShell session, not from GitHub Actions."""
import json
from pathlib import Path

import boto3

ACCOUNT = "055047416353"
ROLE = "fcc-backend-github-deploy"
PROVIDER = f"arn:aws:iam::{ACCOUNT}:oidc-provider/token.actions.githubusercontent.com"
ROOT = Path(__file__).resolve().parent

if boto3.client("sts").get_caller_identity()["Account"] != ACCOUNT:
    raise SystemExit("Unexpected AWS account; no changes made")

iam = boto3.client("iam")
trust = json.loads((ROOT / "github-deploy-trust.json").read_text(encoding="utf-8-sig"))
policy = json.loads((ROOT / "github-deploy-policy.json").read_text(encoding="utf-8-sig"))
try:
    existing = iam.get_open_id_connect_provider(OpenIDConnectProviderArn=PROVIDER)
    if "sts.amazonaws.com" not in existing["ClientIDList"]:
        raise SystemExit("Existing provider lacks the STS audience; review manually")
except iam.exceptions.NoSuchEntityException:
    iam.create_open_id_connect_provider(
        Url="https://token.actions.githubusercontent.com",
        ClientIDList=["sts.amazonaws.com"],
    )

try:
    existing = iam.get_role(RoleName=ROLE)["Role"]
    if existing["AssumeRolePolicyDocument"] != trust:
        raise SystemExit("Existing role has a different trust policy; review manually")
except iam.exceptions.NoSuchEntityException:
    iam.create_role(
        RoleName=ROLE,
        AssumeRolePolicyDocument=json.dumps(trust),
        Description="Deploy the existing FCC backend from GitHub develop using OIDC",
        MaxSessionDuration=3600,
        Tags=[{"Key": "Project", "Value": "FamilyCareCloud"}],
    )

iam.put_role_policy(RoleName=ROLE, PolicyName="FccBackendDeployment", PolicyDocument=json.dumps(policy))
print(f"AWS_DEPLOY_ROLE_ARN=arn:aws:iam::{ACCOUNT}:role/{ROLE}")
print("SAM_ARTIFACT_BUCKET=aws-sam-cli-managed-default-samclisourcebucket-oxjavtgeapap")
