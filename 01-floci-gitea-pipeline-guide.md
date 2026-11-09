# Guide 1 — Build a CI/CD pipeline with Floci + Gitea

This guide walks through a complete local pipeline:

- Gitea hosts the Git repository and runs GitHub-Actions-style workflows.
- Floci emulates AWS (IAM, ECR, EC2, SSM, ELBv2, WAF).
- A push to `main` builds a Docker image, pushes it to Floci ECR, and redeploys
  the container on a Floci EC2 instance over SSM.
- The pipeline uses OIDC. No static AWS access keys are stored in Gitea.

The working example in `floci-cicd-demo/` follows exactly this guide.

## Architecture

```
Gitea push (main)
      |
      v
Gitea Actions runner
      |  OIDC ID token
      v
Floci STS ──> IAM role restricted to this repo + main
      |
      |  temporary credentials
      v
docker build ──> Floci ECR (<commit-sha>, latest)
      |
      |  aws ssm send-command
      v
Floci EC2 (Docker, no inbound SSH)
      |
      v
ALB target group ──> container :8000 ──> Django + React
```

## 1. Prerequisites

Install on the host:

- Docker Engine with the Docker socket available
- Docker Compose v2
- AWS CLI v2
- `curl`, `jq`, `python3`, `git`

Set a few shell variables for the rest of the guide:

```bash
export AWS_ENDPOINT_URL=http://127.0.0.1:4566
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
export GITEA_URL=http://127.0.0.1:3000
export GITEA_OWNER=mskhan
export REPO=demo-app
```

## 2. Start Floci, Gitea, and the runner

Use the parent repository's `docker-compose.yml`, or create one with these
critical settings:

- **Gitea must be `gitea/gitea:main-nightly`**. Stable 1.28 does not expose the
  Actions OIDC endpoint `/api/actions/oidc`.
- Gitea and the runner must share a Docker network.
- The runner must see the Docker socket so it can start job containers.
- The runner must use `http://gitea:3000` as `GITEA_INSTANCE_URL`, not
  `localhost`.

Start the stack:

```bash
docker compose up -d
docker compose ps
```

Check Gitea:

```bash
curl -fsS "$GITEA_URL/api/healthz"
```

Log in to <http://127.0.0.1:3000> with the sandbox credentials and confirm the
runner appears under **Site Administration → Actions → Runners**.

## 3. Create the Gitea repository

Create a repository named `demo-app` in the Gitea UI, then push your application:

```bash
git init
git add .
git commit -m "Initial app"
git branch -M main
git remote add origin "http://127.0.0.1:3000/${GITEA_OWNER}/${REPO}.git"
git push -u origin main
```

The application can be anything that listens on a port. The demo in this
repository uses one image for both React and Django:

- `frontend/` is built by Vite.
- `backend/` is Django + gunicorn + WhiteNoise.
- The Dockerfile copies the Vite build into Django's static/templates.
- The app exposes `/healthz` and `/api/hello/`.

## 4. Create the ECR repository

Floci supports both path-style and virtual-hosted ECR endpoints.

```bash
aws ecr create-repository \
  --repository-name "${REPO}" \
  --image-tag-mutability MUTABLE
```

Inside the runner, push through the path-style endpoint:

```
localhost:4566/000000000000/us-east-1/demo-app
```

Inside EC2, pull through the virtual-hosted endpoint:

```
000000000000.dkr.ecr.us-east-1.localhost:4566/demo-app
```

Floci only routes registry requests on these host forms. On the EC2 instance,
map the virtual-hosted name to Floci:

```bash
echo '172.19.0.3 000000000000.dkr.ecr.us-east-1.localhost' | sudo tee -a /etc/hosts
```

## 5. Create the EC2 instance and SSM access

EC2 in Floci is a nested Docker container. Use a small instance type and do not
open SSH.

Create an SSM-capable instance role:

```bash
cat > ec2-trust.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {"Service": "ec2.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }
  ]
}
JSON

aws iam create-role \
  --role-name demo-ec2-ssm \
  --assume-role-policy-document file://ec2-trust.json

aws iam attach-role-policy \
  --role-name demo-ec2-ssm \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
```

Create the instance profile and attach it to the role:

```bash
aws iam create-instance-profile --instance-profile-name demo-ec2-ssm
aws iam add-role-to-instance-profile \
  --instance-profile-name demo-ec2-ssm \
  --role-name demo-ec2-ssm
```

Create a security group with **only** the application port open. Do not add
port 22.

```bash
VPC_ID=vpc-default-us-east-1
SG_ID=$(aws ec2 create-security-group \
  --group-name demo-app-sg \
  --description "demo app: no SSH" \
  --vpc-id "$VPC_ID" \
  --query GroupId --output text)

aws ec2 authorize-security-group-ingress \
  --group-id "$SG_ID" \
  --protocol tcp --port 8000 --cidr 0.0.0.0/0
```

Start an instance:

```bash
INSTANCE_ID=$(aws ec2 run-instances \
  --image-id ami-ubuntu2404-amd64 \
  --instance-type t3.micro \
  --iam-instance-profile Name=demo-ec2-ssm \
  --security-group-ids "$SG_ID" \
  --query 'Instances[0].InstanceId' --output text)
```

Install Docker and configure Floci's registry. Run these through SSM, or use the
instance user-data/SSM bootstrap in `floci-cicd-demo/infra/ssm-bootstrap.json`.

Key points for Floci:

- Floci EC2 runs as an unprivileged container, so Docker must use
  `"storage-driver": "vfs"`. Overlayfs cannot create whiteout files there.
- Add Floci's ECR host to `/etc/hosts`.
- Configure insecure registries for the local ECR endpoints.

```json
{
  "storage-driver": "vfs",
  "insecure-registries": [
    "localhost:4566",
    "127.0.0.1:4566",
    "000000000000.dkr.ecr.us-east-1.localhost:4566"
  ]
}
```

Verify SSM sees the instance:

```bash
aws ssm describe-instance-information \
  --query 'InstanceInformationList[].[InstanceId,PingStatus,PlatformName]' \
  --output table
```

## 6. Create the Gitea OIDC provider and IAM role

Gitea's issuer is:

```
http://localhost:3000/api/actions/oidc
```

Floci requires provider URLs to start with `https://`, so create the provider
with:

```
https://localhost:3000/api/actions/oidc
```

This is a Floci quirk. The workflow still requests tokens from Gitea.

```bash
aws iam create-open-id-connect-provider \
  --url https://localhost:3000/api/actions/oidc \
  --client-id-list sts.amazonaws.com
```

The Gitea subject contains numeric owner/repository IDs, for example:

```
repo:mskhan@1/demo-app@3:ref:refs/heads/main
```

The subject format is:

```
repo:<owner>@<owner-id>/<repo>@<repo-id>:ref:refs/heads/main
```

Get the numeric IDs from the Gitea API:

```bash
curl -s -u 'mskhan:mskhan@666' \
  "${GITEA_URL}/api/v1/repos/${GITEA_OWNER}/${REPO}" \
  | jq '{owner_id: .owner.id, repo_id: .id}'
```

Create the role trust policy. Save it as `gitea-trust.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::000000000000:oidc-provider/localhost:3000/api/actions/oidc"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "localhost:3000/api/actions/oidc:aud": "sts.amazonaws.com",
          "localhost:3000/api/actions/oidc:sub": "repo:mskhan@1/demo-app@3:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

Create the role and attach a least-privilege policy. The policy should allow only:

- ECR login and push/pull to this one repository.
- `ssm:SendCommand` to this one instance and the `AWS-RunShellScript` document.
- `ssm:GetCommandInvocation` to read the result.
- `ec2:DescribeInstances` for health checks.
- `sts:GetCallerIdentity`.

See `floci-cicd-demo/infra/deploy-policy.json` for a complete example. Save it
as `deploy-policy.json` and run:

```bash
aws iam create-role \
  --role-name demo-github-actions \
  --assume-role-policy-document file://gitea-trust.json

aws iam put-role-policy \
  --role-name demo-github-actions \
  --policy-name demo-deploy \
  --policy-document file://deploy-policy.json
```

The role ARN is:

```
arn:aws:iam::000000000000:role/demo-github-actions
```

Put that value in the workflow as `AWS_ROLE_ARN`.

## 7. Add the Gitea workflow

Create `.github/workflows/deploy.yml`.

Required permissions:

```yaml
permissions:
  contents: read
  issues: write
  id-token: write
```

Define the deployment values in the workflow `env:` block so the shell snippets
below can use them:

```yaml
env:
  AWS_REGION: us-east-1
  AWS_ENDPOINT_URL: http://floci:4566
  AWS_ROLE_ARN: arn:aws:iam::000000000000:role/demo-github-actions
  REPO: demo-app
  EC2_INSTANCE_ID: i-0123456789abcdef0
  CONTAINER_NAME: demo-app
```

The Gitea runner exposes `ACTIONS_ID_TOKEN_REQUEST_URL` and
`ACTIONS_ID_TOKEN_REQUEST_TOKEN`. Rewrite the browser host to the container host:

```bash
TOKEN_URL="${ACTIONS_ID_TOKEN_REQUEST_URL/http:\/\/localhost:3000/http:\/\/gitea:3000}"
RESPONSE=$(curl -fsS \
  -H "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
  "${TOKEN_URL}&audience=sts.amazonaws.com")
ID_TOKEN=$(jq -r '.value // empty' <<< "${RESPONSE}")
```

Exchange the token for temporary credentials. Floci accepts unsigned STS
requests, so use `--no-sign-request`:

```bash
CREDS=$(aws sts assume-role-with-web-identity \
  --role-arn "$AWS_ROLE_ARN" \
  --role-session-name "gitea-${GITHUB_RUN_ID}" \
  --web-identity-token "$ID_TOKEN" \
  --duration-seconds 3600 \
  --no-sign-request \
  --endpoint-url "$AWS_ENDPOINT_URL" \
  --output json)
```

Write the credentials to `GITHUB_ENV` so later steps inherit them:

```bash
{
  echo "AWS_ACCESS_KEY_ID=$(jq -r '.Credentials.AccessKeyId' <<< "$CREDS")"
  echo "AWS_SECRET_ACCESS_KEY=$(jq -r '.Credentials.SecretAccessKey' <<< "$CREDS")"
  echo "AWS_SESSION_TOKEN=$(jq -r '.Credentials.SessionToken' <<< "$CREDS")"
} >> "$GITHUB_ENV"
```

Do not call `aws sts get-caller-identity` in the same step unless you also
`export` the variables. Gitea applies `GITHUB_ENV` after the step finishes.

Build and push:

```bash
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin localhost:4566

docker build \
  -t "localhost:4566/000000000000/us-east-1/${REPO}:${GITHUB_SHA}" \
  -t "localhost:4566/000000000000/us-east-1/${REPO}:latest" .

docker push "localhost:4566/000000000000/us-east-1/${REPO}:${GITHUB_SHA}"
docker push "localhost:4566/000000000000/us-east-1/${REPO}:latest"
```

Deploy with SSM. The deploy script runs on EC2:

```bash
set -eux
grep -q 'dkr.ecr.us-east-1.localhost' /etc/hosts || \
  echo '172.19.0.3 000000000000.dkr.ecr.us-east-1.localhost' >> /etc/hosts

# Floci only: use vfs if Docker needs to be started.
if ! docker info >/dev/null 2>&1; then
  nohup dockerd --storage-driver=vfs --host=unix:///var/run/docker.sock \
    >/var/log/dockerd.log 2>&1 &
  for i in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 2
  done
fi

IMAGE="000000000000.dkr.ecr.us-east-1.localhost:4566/${REPO}:${GITHUB_SHA}"
docker pull "$IMAGE"
docker rm -f demo-app || true
docker run -d --name demo-app --restart unless-stopped -p 8000:8000 "$IMAGE"

for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8000/healthz >/dev/null; then
    echo "DEPLOY_HEALTHY version=${GITHUB_SHA}"
    exit 0
  fi
  sleep 2
done
exit 1
```

Send the script with `aws ssm send-command`, then poll
`aws ssm get-command-invocation` until the status is `Success`, `Failed`,
`Cancelled`, or `TimedOut`:

```bash
PARAMS_FILE=$(mktemp)
jq -n --rawfile script /tmp/deploy-remote.sh \
  '{commands: ($script | split("\n"))}' > "$PARAMS_FILE"

COMMAND_ID=$(aws ssm send-command \
  --instance-ids "$EC2_INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "Deploy ${GITHUB_SHA}" \
  --timeout-seconds 600 \
  --parameters "file://${PARAMS_FILE}" \
  --query 'Command.CommandId' --output text)

for i in $(seq 1 90); do
  STATUS=$(aws ssm get-command-invocation \
    --command-id "$COMMAND_ID" \
    --instance-id "$EC2_INSTANCE_ID" \
    --query 'Status' --output text 2>/dev/null || echo Pending)
  case "$STATUS" in
    Success|Failed|Cancelled|TimedOut) break ;;
  esac
  sleep 5
done

aws ssm get-command-invocation \
  --command-id "$COMMAND_ID" \
  --instance-id "$EC2_INSTANCE_ID" \
  --query '{Status:Status,StdOut:StandardOutputContent,StdErr:StandardErrorContent}' \
  --output json

test "$STATUS" = "Success"
```

The complete working workflow is in
`floci-cicd-demo/.github/workflows/deploy.yml`.

## 8. Push and verify

```bash
git add .
git commit -m "Add deploy workflow"
git push origin main
```

Watch the run in Gitea: **Repository → Actions**.

Verify:

```bash
# ECR tags
aws ecr describe-images \
  --repository-name "$REPO" \
  --query 'imageDetails[].imageTags' --output json

# App directly on the published EC2 port
curl http://127.0.0.1:30002/healthz
curl http://127.0.0.1:30002/api/hello/
```

A successful deploy log contains `DEPLOY_HEALTHY`.

## 9. Optional: static ALB and WAF

The pipeline should not create or change the ALB, target group, or WAF. Create
them once:

1. Create a target group on port `8000` with health check path `/healthz`.
2. Register the EC2 instance.
3. Create an ALB listener that forwards to the target group.
4. Create a WAF web ACL and associate it with the ALB ARN.

Floci listener sockets bind inside the Floci container. From the host, reach the
listener through `172.19.0.3:<listener-port>` and select the ALB with a `Host`
header. On real AWS, the ALB DNS name handles this.

The pipeline only replaces the application container. ALB target health and WAF
association therefore survive every deploy.

## 10. Failure notification

Add a second job that runs only on failure:

```yaml
notify-failure:
  needs: build-push-deploy
  if: failure()
  runs-on: ubuntu-latest
  steps:
    - name: Open or update a Gitea issue
      env:
        TOKEN: ${{ secrets.ISSUE_TOKEN }}
      run: |
        # POST /api/v1/repos/<owner>/<repo>/issues
        # or POST /api/v1/repos/<owner>/<repo>/issues/<number>/comments
        ...
```

Create a Gitea token with `read:repository` and `write:issue` scopes and store it
as `ISSUE_TOKEN`. Gitea reserves secret names beginning with `GITEA_` or
`GITHUB_`.

To verify the path, temporarily add a failing `RUN` instruction to the
Dockerfile. The build must fail, the deploy step must be skipped, and an issue
must be created. Remove the failing instruction afterwards.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `404` on `/api/actions/oidc` | Stable Gitea lacks OIDC | Use `gitea/gitea:main-nightly` |
| `Unable to locate credentials` on assume-role | AWS CLI tried to sign the request | Add `--no-sign-request` |
| `get-caller-identity` fails in the assume step | `GITHUB_ENV` is applied after the step | Move it to a separate step |
| Image pull fails with `operation not permitted` | Overlayfs in nested Floci EC2 | Use Docker's `vfs` storage driver |
| ECR host not found on EC2 | Floci only routes virtual-hosted names | Add the `/etc/hosts` entry |
| `docker pull` is denied | Registry host form is wrong | Use `localhost:4566` in the runner and `<account>.dkr.ecr.<region>.localhost:4566` in EC2 |
| Job hangs on Docker | Runner cannot reach Docker socket | Mount `/var/run/docker.sock` into the runner |
| `No listener for host` | Multiple ALB listeners on one port | Send the ALB DNS name in the `Host` header |

## Key limitations

- Floci IAM enforcement is incomplete. It accepts tokens from issuers it does
  not host when the target role exists. The trust policy is still written the way
  real AWS evaluates it.
- Floci OIDC provider URLs must begin with `https://`.
- ECR registry routing only accepts the two host forms shown above.
- Emulated security groups and WAF rules are control-plane metadata, not host
  firewalls.
- Use `--no-sign-request` only against Floci. Real AWS requires signed STS calls.
