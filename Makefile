include $(env).env

check_changes:
	aws cloudformation create-change-set \
	--stack-name $(stack_name) \
	--change-set-name SampleChangeSet \
	--template-body file://stack_full.yml \
	--include-nested-stacks \
	--parameters \
		ParameterKey="S3BucketName",ParameterValue=$(s3bucket_name) \
		ParameterKey="DatabaseName",ParameterValue=$(db_name) \
		ParameterKey="DbSecretName",ParameterValue=$(db_secret_name)
	--profile $(profile) --region $(region)

deploy: prepare upload
	aws cloudformation deploy \
    --template-file stack_full.yml \
    --stack-name $(stack_name) \
    --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND CAPABILITY_NAMED_IAM \
    --parameter-overrides \
		S3BucketName=$(s3bucket_name) \
        DatabaseName=$(db_name) \
		DbSecretName=$(db_secret_name) \
	--profile $(profile) --region $(region)

clean:
	rm -fr stack_full.yml

upload:
	aws s3 sync ./ $(codeupload_path) \
	--include "*" \
	--exclude ".git/*" \
	--profile $(profile)

prepare:
	python3 make_cf_template.py stack.yml $(foreach V,$(sort $(.VARIABLES)),$(if $(filter-out environment% default automatic,$(origin $V)), "$V=$($V)")) > stack_full.yml;
