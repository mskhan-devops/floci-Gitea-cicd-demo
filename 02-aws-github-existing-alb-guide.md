# Guide 2 — Deploy from GitHub Actions to an existing AWS ALB environment

This guide connects a GitHub repository to an existing AWS environment that
already has an Application Load Balancer (ALB). It covers only:

1. Setting up the IAM role.
2. Configuring OIDC and removing inbound SSH.
3. Setting up SSM.
4. Pushing the image to ECR.
5. Deploying the image to the instance with SSM Run Command.

The pipeline does **not** create or modify the VPC, subnets, security groups,
ALB, listener, target group, or WAF. It only builds a new image and replaces the
container on the existing instance.

## Assumptions

- The instance is already registered in an existing ALB target group.
- The target group forwards to the container port (examples use `8000`) and has
  a health check path (examples use `/healthz`).
- The instance runs a Linux AMI with Docker and the SSM agent.
- One instance is targeted in this guide. For an Auto Scaling group, run the same
  SSM command against all instances or use SSM targeting by tag.
- Changes to the target group port or health check are done once, manually, and
  are not part of the pipeline.

Set these variables in your shell:

```bash
export AWS_REGION=us-east-1
export ACCOUNT_ID=123456789012
export GITHUB_ORG=my-org
export GITHUB_REPO=my-repo
export ROLE_NAME=github-actions-ecr-ssm-deploy
export INSTANCE_ID=i-0123456789abcdef0
export INSTANCE_SG=sg-0123456789abcdef0
export ALB_SG=sg-0fedcba9876543210
export ECR_REPO=my-app
export CONTAINER_NAME=my-app
export APP_PORT=8000
export HEALTH_PATH=/healthz
```

Use the real values from your AWS account. The commands below assume the AWS CLI
is configured for that account.

## 1. Set up the IAM role

Create a role that GitHub Actions can assume through OIDC. It should not have an
access key and should not have administrator permissions.

### 1.1 Create the trust policy

```bash
cat > github-trust.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:${GITHUB_ORG}/${GITHUB_REPO}:ref:refs/heads/main"
        }
      }
    }
  ]
}
JSON
```

The `sub` condition is the important restriction. It allows only this repository
on the `main` branch. The action will not be able to assume the role from another
repository or branch.

### 1.2 Create the role

Create the GitHub OIDC provider first if your account does not already have it:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
```

The provider ARN is normally:

```
arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com
```

Then create the role:

```bash
aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document file://github-trust.json
```

### 1.3 Attach least-privilege permissions

```bash
cat > github-permissions.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcrLogin",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "PushPullThisRepository",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:CompleteLayerUpload",
        "ecr:InitiateLayerUpload",
        "ecr:PutImage",
        "ecr:UploadLayerPart",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
        "ecr:DescribeImages",
        "ecr:DescribeRepositories",
        "ecr:ListImages"
      ],
      "Resource": "arn:aws:ecr:${AWS_REGION}:${ACCOUNT_ID}:repository/${ECR_REPO}"
    },
    {
      "Sid": "SendCommandToThisInstanceOnly",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": [
        "arn:aws:ec2:${AWS_REGION}:${ACCOUNT_ID}:instance/${INSTANCE_ID}",
        "arn:aws:ssm:${AWS_REGION}::document/AWS-RunShellScript"
      ]
    },
    {
      "Sid": "ReadCommandResult",
      "Effect": "Allow",
      "Action": [
        "ssm:GetCommandInvocation",
        "ssm:ListCommandInvocations",
        "ssm:ListCommands"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ReadInstanceHealth",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceStatus",
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    }
  ]
}
JSON

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "${ROLE_NAME}-policy" \
  --policy-document file://github-permissions.json
```

The workflow needs the role ARN:

```
arn:aws:iam::<ACCOUNT_ID>:role/<ROLE_NAME>
```

Store it as a repository variable (not a secret), for example
`AWS_ROLE_ARN`.

## 2. Configure OIDC and remove inbound SSH

### 2.1 GitHub side

The workflow must request an OIDC token:

```yaml
permissions:
  contents: read
  id-token: write
```

Then use the official action to assume the role:

```yaml
- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: ${{ env.AWS_ROLE_ARN }}
    aws-region: ${{ env.AWS_REGION }}
```

No AWS access key or secret is stored in GitHub.

### 2.2 AWS side: no SSH

The CI/CD job never needs SSH. Use SSM instead. The instance security group
should allow the application port only from the ALB security group, and no
inbound port 22.

```bash
# Allow the ALB to reach the app port. Skip if this rule already exists.
aws ec2 authorize-security-group-ingress \
  --group-id "$INSTANCE_SG" \
  --protocol tcp \
  --port "$APP_PORT" \
  --source-group "$ALB_SG"

# Remove an existing world-open SSH rule if present.
aws ec2 revoke-security-group-ingress \
  --group-id "$INSTANCE_SG" \
  --protocol tcp \
  --port 22 \
  --cidr 0.0.0.0/0 || true
```

Check that no port 22 rule remains:

```bash
aws ec2 describe-security-groups \
  --group-ids "$INSTANCE_SG" \
  --query 'SecurityGroups[0].IpPermissions[?FromPort==`22`]'
```

If you need an interactive shell for troubleshooting, use SSM Session Manager
from an authorized operator machine:

```bash
aws ssm start-session --target "$INSTANCE_ID"
```

That permission belongs to the human operator, not to the GitHub deployment
role.

## 3. Set up SSM

### 3.1 Give the instance an SSM-capable role

The instance needs:

- `AmazonSSMManagedInstanceCore` for SSM Run Command and Session Manager.
- `AmazonEC2ContainerRegistryReadOnly` so it can authenticate to ECR and pull
  the image.

If the instance already has an instance profile, attach these policies to its
existing role:

```bash
INSTANCE_ROLE=my-existing-ec2-role

aws iam attach-role-policy \
  --role-name "$INSTANCE_ROLE" \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

aws iam attach-role-policy \
  --role-name "$INSTANCE_ROLE" \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly
```

If it has no profile, create one:

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
  --role-name ec2-app-ssm \
  --assume-role-policy-document file://ec2-trust.json

aws iam attach-role-policy \
  --role-name ec2-app-ssm \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

aws iam attach-role-policy \
  --role-name ec2-app-ssm \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly

aws iam create-instance-profile --instance-profile-name ec2-app-ssm
aws iam add-role-to-instance-profile \
  --instance-profile-name ec2-app-ssm \
  --role-name ec2-app-ssm
aws ec2 associate-iam-instance-profile \
  --instance-id "$INSTANCE_ID" \
  --iam-instance-profile Name=ec2-app-ssm
```

An instance can have only one instance profile. If one is already attached,
attach the policies to its role instead of replacing it.

### 3.2 Install and verify the SSM agent

Amazon Linux 2023 usually includes the agent. Ubuntu needs the Amazon SSM agent
package. Verify:

```bash
sudo systemctl status amazon-ssm-agent
```

From your workstation:

```bash
aws ssm describe-instance-information \
  --filters "Key=InstanceIds,Values=${INSTANCE_ID}" \
  --query 'InstanceInformationList[0].PingStatus' \
  --output text
```

It must return `Online` before the deployment can work.

### 3.3 Install Docker and AWS CLI v2

On Amazon Linux 2023:

```bash
sudo dnf install -y docker unzip
sudo systemctl enable --now docker

curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
sudo /tmp/aws/install

docker version
aws --version
aws sts get-caller-identity
```

On Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y docker.io unzip
sudo systemctl enable --now docker

curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
sudo /tmp/aws/install

docker version
aws --version
aws sts get-caller-identity
```

`aws sts get-caller-identity` on the instance should return the instance role.
SSM Run Command executes as root on standard Linux AMIs; add `sudo` if your SSM
configuration uses a non-root user.

### 3.4 Network requirements

The instance needs outbound HTTPS to SSM, EC2 Messages, ECR, and S3. If it is in
a private subnet without a NAT gateway, add VPC endpoints for:

- `com.amazonaws.<region>.ssm`
- `com.amazonaws.<region>.ssmmessages`
- `com.amazonaws.<region>.ec2messages`
- `com.amazonaws.<region>.ecr.api`
- `com.amazonaws.<region>.ecr.dkr`
- `com.amazonaws.<region>.s3` (gateway endpoint)

## 4. Push the image to ECR

### 4.1 Create the repository

```bash
aws ecr create-repository \
  --repository-name "$ECR_REPO" \
  --image-tag-mutability MUTABLE \
  --region "$AWS_REGION"
```

If the repository already exists, skip this command. `MUTABLE` lets you move the
`latest` tag. If your repository is immutable, push only the commit SHA tag.

### 4.2 Build and push in GitHub Actions

```yaml
- name: Build and push image
  run: |
    set -euo pipefail

    ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
    ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
    IMAGE="${ECR_REGISTRY}/${ECR_REPO}"

    aws ecr get-login-password --region "$AWS_REGION" \
      | docker login --username AWS --password-stdin "$ECR_REGISTRY"

    docker build \
      -t "${IMAGE}:${GITHUB_SHA}" \
      -t "${IMAGE}:latest" \
      .

    docker push "${IMAGE}:${GITHUB_SHA}"
    docker push "${IMAGE}:latest"

    echo "IMAGE=${IMAGE}:${GITHUB_SHA}" >> "$GITHUB_ENV"
```

The commit SHA tag is the immutable deployment artifact. `latest` is a moving
alias for convenience.

## 5. Deploy the image with SSM Run Command

### 5.1 How the deploy works

The workflow sends a shell script to the instance with `ssm:SendCommand`. The
script runs on the instance, logs in to ECR using the instance role, pulls the
new image, replaces the container, and checks the health endpoint.

The existing ALB target group continues to point at the same instance and port.
No ALB change is needed.

### 5.2 Deploy script

```bash
set -eux

# ECR login uses the EC2 instance profile.
aws ecr get-login-password --region "__AWS_REGION__" \
  | docker login --username AWS --password-stdin "__ECR_REGISTRY__"

docker pull "__IMAGE__"

docker rm -f "__CONTAINER_NAME__" >/dev/null 2>&1 || true
docker run -d \
  --name "__CONTAINER_NAME__" \
  --restart unless-stopped \
  -p "__APP_PORT__:__APP_PORT__" \
  "__IMAGE__"

for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:__APP_PORT____HEALTH_PATH__" >/dev/null; then
    echo "DEPLOY_OK"
    exit 0
  fi
  sleep 2
done

docker logs "__CONTAINER_NAME__" || true
exit 1
```

Replace the `__PLACEHOLDER__` values when generating the script. The workflow
below does this automatically.

### 5.3 Complete GitHub Actions workflow

Create `.github/workflows/deploy.yml`:

```yaml
name: Build and Deploy

on:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write

env:
  AWS_REGION: us-east-1
  AWS_ROLE_ARN: ${{ vars.AWS_ROLE_ARN }}
  ECR_REPO: my-app
  INSTANCE_ID: i-0123456789abcdef0
  CONTAINER_NAME: my-app
  APP_PORT: "8000"
  HEALTH_PATH: /healthz

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Assume the AWS role through OIDC
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ env.AWS_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Build and push image to ECR
        run: |
          set -euo pipefail

          ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
          ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
          IMAGE="${ECR_REGISTRY}/${ECR_REPO}"

          aws ecr get-login-password --region "$AWS_REGION" \
            | docker login --username AWS --password-stdin "$ECR_REGISTRY"

          docker build \
            -t "${IMAGE}:${GITHUB_SHA}" \
            -t "${IMAGE}:latest" \
            .

          docker push "${IMAGE}:${GITHUB_SHA}"
          docker push "${IMAGE}:latest"

          echo "IMAGE=${IMAGE}:${GITHUB_SHA}" >> "$GITHUB_ENV"

      - name: Deploy on EC2 with SSM Run Command
        run: |
          set -euo pipefail

          cat > /tmp/deploy-remote.sh <<REMOTE
          set -eux

          aws ecr get-login-password --region "${AWS_REGION}" \
            | docker login --username AWS --password-stdin "${IMAGE%%/*}"

          docker pull "${IMAGE}"

          docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
          docker run -d \
            --name "${CONTAINER_NAME}" \
            --restart unless-stopped \
            -p "${APP_PORT}:${APP_PORT}" \
            "${IMAGE}"

          for i in \$(seq 1 30); do
            if curl -fsS "http://127.0.0.1:${APP_PORT}${HEALTH_PATH}" >/dev/null; then
              echo "DEPLOY_OK version=${GITHUB_SHA}"
              exit 0
            fi
            sleep 2
          done

          docker logs "${CONTAINER_NAME}" || true
          exit 1
          REMOTE

          PARAMS_FILE="$(mktemp)"
          jq -n --rawfile script /tmp/deploy-remote.sh \
            '{commands: ($script | split("\n"))}' > "$PARAMS_FILE"

          COMMAND_ID="$(aws ssm send-command \
            --instance-ids "$INSTANCE_ID" \
            --document-name "AWS-RunShellScript" \
            --comment "Deploy ${GITHUB_SHA}" \
            --timeout-seconds 600 \
            --parameters "file://${PARAMS_FILE}" \
            --query 'Command.CommandId' \
            --output text)"

          echo "SSM command: ${COMMAND_ID}"

          for i in $(seq 1 90); do
            STATUS="$(aws ssm get-command-invocation \
              --command-id "$COMMAND_ID" \
              --instance-id "$INSTANCE_ID" \
              --query 'Status' \
              --output text 2>/dev/null || echo Pending)"

            case "$STATUS" in
              Success|Failed|Cancelled|TimedOut) break ;;
            esac
            sleep 5
          done

          aws ssm get-command-invocation \
            --command-id "$COMMAND_ID" \
            --instance-id "$INSTANCE_ID" \
            --query '{Status:Status,StdOut:StandardOutputContent,StdErr:StandardErrorContent}' \
            --output json

          test "$STATUS" = "Success"
```

### 5.4 Verify the deployment

```bash
# Latest image tags
aws ecr describe-images \
  --repository-name "$ECR_REPO" \
  --region "$AWS_REGION" \
  --query 'imageDetails[].imageTags' \
  --output json

# SSM command status
aws ssm get-command-invocation \
  --command-id "<COMMAND_ID>" \
  --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,StdOut:StandardOutputContent,StdErr:StandardErrorContent}'

# Through the existing ALB
curl -fsS "http://<ALB_DNS_NAME>${HEALTH_PATH}"
```

A successful SSM run prints `DEPLOY_OK version=<commit-sha>`.

If the new container fails its health check, the SSM command fails and the
GitHub job fails. The previous image tag remains in ECR, so rollback is just a
redeploy of the previous SHA:

```bash
IMAGE="<ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/${ECR_REPO}:<PREVIOUS_SHA>"
```

Run the same SSM deploy step with that image.

## Key points

- The ALB, target group, listener, VPC, and WAF are untouched by this pipeline.
- The instance needs no inbound SSH. SSM handles remote execution.
- The GitHub role has no static credentials and is restricted to one repository
  and `main`.
- The instance role is separate from the GitHub role:
  - GitHub role: push to ECR and call SSM.
  - Instance role: register with SSM and pull from ECR.
- Use the commit SHA tag for deployment. Use `latest` only as a convenience alias.
- If the ALB target group uses a different port or health check path, change
  `APP_PORT` and `HEALTH_PATH` in the workflow to match.
