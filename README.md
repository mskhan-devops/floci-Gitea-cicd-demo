# Floci CI/CD demo: Django + React on Gitea Actions

A minimal full-stack application plus a GitHub-Actions-style pipeline that runs on
local Gitea and deploys to a local Floci (AWS emulator) account.

Every push to `main`:

1. Gets a short-lived OIDC token from Gitea Actions.
2. Exchanges it for temporary AWS credentials with `sts:AssumeRoleWithWebIdentity`.
3. Builds one Docker image that contains the React bundle and the Django app.
4. Pushes the image to Floci ECR tagged with both the commit SHA and `latest`.
5. Deploys the new image on the Floci EC2 instance over SSM Run Command.
6. Fails fast if the build or push fails, and opens/comments on a Gitea issue.

The pipeline never creates or modifies the VPC, subnets, security groups, ALB, or
WAF. It only replaces the application container behind the existing target group.

```
Gitea push (main)
      |
      v
Gitea Actions runner ── OIDC ──> Floci STS ──> IAM role
      |                                         (repo + main only)
      | docker build
      v
Floci ECR  ── image: <sha>, latest
      |
      | aws ssm send-command
      v
Floci EC2 (Docker, no inbound SSH)
      |
      | docker pull + docker run -p 8000
      v
ALB :8080 ──> target group ──> EC2 :8000 ──> Django + React
      ^
      |
WAF web ACL (static, not touched by the pipeline)
```

## Repository layout

```
backend/                 Django project (API + SPA host)
  api/views.py           /api/hello/ and /healthz
  config/settings.py     WhiteNoise, static files, no DB
frontend/                React + Vite single-page app
Dockerfile               multi-stage: Vite build -> Django runtime
.github/workflows/deploy.yml
infra/                   IAM trust/permission policies and SSM bootstrap
```

## Run locally

### Backend only

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python manage.py runserver 0.0.0.0:8000
curl http://127.0.0.1:8000/api/hello/
```

### Frontend dev server

The Vite dev server proxies `/api` to Django on port 8000.

```bash
cd frontend
npm ci
npm run dev
```

### Combined production image

```bash
docker build -t floci-cicd-demo:local .
docker run --rm -p 18000:8000 floci-cicd-demo:local
curl http://127.0.0.1:18000/healthz
```

## Gitea Actions setup

The workflow relies on Gitea's native OIDC provider, which was added after the
1.28 stable branch. This environment uses `gitea/gitea:main-nightly` (1.29 dev).
The parent `docker-compose.yml` already sets that image.

Workflow permissions:

```yaml
permissions:
  contents: read
  issues: write
  id-token: write
```

The runner exposes `ACTIONS_ID_TOKEN_REQUEST_URL` and
`ACTIONS_ID_TOKEN_REQUEST_TOKEN`. Gitea advertises the URL with the browser host
`localhost:3000`, which job containers cannot resolve. The workflow rewrites it
to `http://gitea:3000` before requesting a token:

```bash
TOKEN_URL="${ACTIONS_ID_TOKEN_REQUEST_URL/http:\/\/localhost:3000/http:\/\/gitea:3000}"
```

The token request must ask for the AWS audience explicitly:

```bash
curl -H "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
  "${TOKEN_URL}&audience=sts.amazonaws.com"
```

Because Floci accepts unsigned STS requests, the assume-role call uses
`--no-sign-request`. Temporary credentials are written to `GITHUB_ENV` and used
by later steps. They are never stored in Gitea Secrets.

### Failure notification secret

Create a personal access token with `read:repository` and `write:issue` scopes
and store it as the repository secret `ISSUE_TOKEN`:

```bash
curl -X PUT -u 'mskhan:mskhan@666' \
  -H 'Content-Type: application/json' \
  -d "{\"data\":\"${TOKEN}\"}" \
  http://127.0.0.1:3000/api/v1/repos/mskhan/floci-cicd-demo/actions/secrets/ISSUE_TOKEN
```

Gitea rejects secret names that start with `GITEA_` or `GITHUB_`.

## Floci infrastructure used by this demo

All commands assume:

```bash
export AWS_ENDPOINT_URL=http://127.0.0.1:4566
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
```

### ECR

```bash
aws ecr create-repository \
  --repository-name floci-cicd-demo/app \
  --image-tag-mutability MUTABLE
```

The runner pushes through the path-style endpoint:

```
localhost:4566/000000000000/us-east-1/floci-cicd-demo/app
```

EC2 pulls through the virtual-hosted endpoint:

```
000000000000.dkr.ecr.us-east-1.localhost:4566/floci-cicd-demo/app
```

Floci only routes registry requests on those two host forms. The instance's
`/etc/hosts` maps the virtual-hosted name to Floci:

```
172.19.0.3 000000000000.dkr.ecr.us-east-1.localhost
```

### EC2 + SSM

Current demo instance:

| Resource | Value |
| --- | --- |
| Instance | `i-8760d08270b0ad114` |
| Type | `t3.micro` |
| Private IP | `172.31.0.10` |
| Security group | `sg-5e36bec3a1f091a03` (`floci-cicd-demo-ec2`) |
| Inbound | TCP 8000 only; no port 22 |
| Instance profile | `floci-cicd-demo-ec2` |
| SSM role | `floci-cicd-demo-ec2-ssm` (`AmazonSSMManagedInstanceCore`) |

The instance is managed exclusively through SSM. Docker is installed by an SSM
bootstrap command; see `infra/ssm-bootstrap.json`.

Floci runs each emulated EC2 instance as an unprivileged nested container. The
`overlayfs` Docker driver cannot create whiteout files there, so the bootstrap
and the deploy script use the `vfs` storage driver. This is an emulator
limitation, not an AWS requirement.

### IAM OIDC provider and role

Floci requires provider URLs to start with `https://`, even though Gitea's local
issuer is `http://localhost:3000/api/actions/oidc`. The provider used here is:

```
arn:aws:iam::000000000000:oidc-provider/localhost:3000/api/actions/oidc
```

The role is `floci-cicd-demo-github-actions`. Its trust policy restricts both
the audience and the exact Gitea subject for this repository and `main`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GiteaActionsMainBranchOnly",
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::000000000000:oidc-provider/localhost:3000/api/actions/oidc"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "localhost:3000/api/actions/oidc:aud": "sts.amazonaws.com",
          "localhost:3000/api/actions/oidc:sub": "repo:mskhan@1/floci-cicd-demo@3:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

The inline permissions policy is in `infra/deploy-policy.json`. It allows only:

- ECR login, plus push/pull on the one demo repository.
- `ssm:SendCommand` against the one instance and `AWS-RunShellScript`.
- Reading that command's result.
- `ec2:DescribeInstances` / `DescribeInstanceStatus` for health checks.
- `sts:GetCallerIdentity`.

No static AWS keys are stored in the repository or in Gitea.

On real AWS, replace the Floci endpoint variables with normal AWS endpoints and
remove `--no-sign-request`. The OIDC provider URL would be Gitea's public HTTPS
URL and the subject prefix would use the real owner/repository IDs.

### ALB and WAF (static)

The pipeline does not call ELBv2 or WAF. These were provisioned once for the
demo and remain unchanged across deploys:

| Resource | Value |
| --- | --- |
| ALB | `floci-cicd-demo-alb` |
| ALB ARN | `arn:aws:elasticloadbalancing:us-east-1:000000000000:loadbalancer/app/floci-cicd-demo-alb/3532fd4ea9a64b7d` |
| DNS name | `floci-cicd-demo-alb-3532fd4ea9a64b7d.elb.localhost.floci.io` |
| Target group | `floci-cicd-demo-tg` (HTTP 8000, `/healthz`) |
| Listener | HTTP 8080 -> target group |
| WAF web ACL | `floci-cicd-demo-waf` (allow by default, blocks `203.0.113.0/24`) |
| WAF association | ALB ARN above |

Floci listener sockets bind inside the Floci container, which is reachable from
the host at `172.19.0.3:8080`. Requests must select the ALB by `Host` header:

```bash
curl -H 'Host: floci-cicd-demo-alb-3532fd4ea9a64b7d.elb.localhost.floci.io' \
  http://172.19.0.3:8080/api/hello/
```

### Deploy from the host (manual equivalent)

```bash
aws ssm send-command \
  --instance-ids i-8760d08270b0ad114 \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["docker pull 000000000000.dkr.ecr.us-east-1.localhost:4566/floci-cicd-demo/app:latest","docker rm -f floci-cicd-demo || true","docker run -d --name floci-cicd-demo --restart unless-stopped -p 8000:8000 000000000000.dkr.ecr.us-east-1.localhost:4566/floci-cicd-demo/app:latest"]'
```

## Verification

```bash
# Latest workflow run and jobs
curl -s -u 'mskhan:mskhan@666' \
  http://127.0.0.1:3000/api/v1/repos/mskhan/floci-cicd-demo/actions/runs?limit=5

# Image tags (expect <sha> and latest)
aws ecr describe-images --repository-name floci-cicd-demo/app \
  --query 'imageDetails[].imageTags'

# Target health
aws elbv2 describe-target-health \
  --target-group-arn arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/floci-cicd-demo-tg/c1d42843db9e4082

# Through the ALB
curl -H 'Host: floci-cicd-demo-alb-3532fd4ea9a64b7d.elb.localhost.floci.io' \
  http://172.19.0.3:8080/api/hello/

# Directly through Floci's published EC2 port
curl http://127.0.0.1:30002/api/hello/
```

A successful deploy log contains:

```
DEPLOY_HEALTHY version=<commit-sha>
```

## Failure behavior

`Build and push image to ECR` uses `set -euo pipefail`, so a failed `docker build`
or `docker push` stops the job immediately. `Deploy on EC2 over SSM` is skipped.
The `notify-failure` job runs only with `if: failure()`, then opens a Gitea issue
named `Deploy failed on main (<short-sha>)` or comments on the existing open one.

This path was tested by temporarily adding a failing `RUN` instruction to the
Dockerfile: the build step failed, the deploy step was skipped, and issue #4 was
created automatically.

## Floci-specific limitations

- IAM enforcement is not complete. The demo accepts OIDC tokens from issuers it
  does not host when the target role exists. The trust policy still records the
  correct repository and branch restrictions, matching what real AWS evaluates.
- OIDC provider URLs in Floci must begin with `https://`.
- ECR registry routing only accepts `localhost:4566` and
  `<account>.dkr.ecr.<region>.localhost:4566`.
- Emulated EC2 instances are nested containers, so Docker needs `vfs`.
- Floci publishes its own debugging SSH proxy for each emulated instance (for
  example host port `2201`). That proxy is part of the emulator's control plane,
  not an AWS security-group rule; the EC2 security group in this demo has no
  inbound port 22 rule.
- ELBv2 forwards traffic, evaluates health checks, and supports WAF association,
  but security groups, NACLs, and WAF rules are control-plane metadata, not host
  firewalls.
- ALB listener ports are container ports, not host-published ports unless the
  Floci container publishes them.
