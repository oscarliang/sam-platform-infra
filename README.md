# sam-platform-infra

1. Configure aws cli profile

2. Create s3 bucket in your aws account ( for cloudformation scripts )

3. Then update below veriable in dev.env file

profile=YOUR_CLI_PROFILE ( step 1 )
deploy_bucket=YOUR S3_BUCKET ( step 2 )
region=ap-southeast-2 ( CHOOSE_YOUR_REGION )

4. Run below command
make deploy env=dev
