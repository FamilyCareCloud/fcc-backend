"""Run once in an authorized AWS CloudShell session to permit the FCC auth deployment."""
import json
import boto3

region = 'ap-northeast-2'
account = '055047416353'
if boto3.client('sts').get_caller_identity()['Account'] != account:
    raise SystemExit('Unexpected AWS account; no changes made')
cf = boto3.client('cloudformation', region_name=region)
resources = cf.describe_stack_resources(StackName='fcc-backend-dev')['StackResources']
by_id = {item['LogicalResourceId']: item for item in resources}
pool = by_id['UserPool']['PhysicalResourceId']
api = by_id['Api']['PhysicalResourceId']
runtime_role = by_id['BackendRole']['PhysicalResourceId']
if runtime_role != 'fcc-backend-dev-BackendRole-ypNH6kQpQWTt':
    raise SystemExit('Unexpected runtime role; no changes made')
policy = {'Version': '2012-10-17', 'Statement': [
    {'Sid': 'UpdateExistingFccApi', 'Effect': 'Allow',
     'Action': ['apigateway:GET', 'apigateway:PATCH'],
     'Resource': f'arn:aws:apigateway:{region}::/apis/{api}'},
    {'Sid': 'UpdateExistingFccUserPool', 'Effect': 'Allow',
     'Action': ['cognito-idp:DescribeUserPool', 'cognito-idp:UpdateUserPool', 'cognito-idp:ListTagsForResource'],
     'Resource': f'arn:aws:cognito-idp:{region}:{account}:userpool/{pool}'},
    {'Sid': 'UpdateExistingFccRuntimePolicy', 'Effect': 'Allow',
     'Action': ['iam:PutRolePolicy'],
     'Resource': f'arn:aws:iam::{account}:role/{runtime_role}'}
]}
boto3.client('iam').put_role_policy(RoleName='fcc-backend-github-deploy', PolicyName='FccAuthDeployment', PolicyDocument=json.dumps(policy))
print('FCC auth deployment permissions configured.')
status = cf.describe_stacks(StackName='fcc-backend-dev')['Stacks'][0]['StackStatus']
if status == 'UPDATE_ROLLBACK_FAILED':
    cf.continue_update_rollback(StackName='fcc-backend-dev')
    import time
    for attempt in range(60):
        status = cf.describe_stacks(StackName='fcc-backend-dev')['Stacks'][0]['StackStatus']
        if status == 'UPDATE_ROLLBACK_COMPLETE':
            break
        if status == 'UPDATE_ROLLBACK_FAILED':
            raise SystemExit('Rollback still failed; inspect CloudFormation events before rerunning deployment')
        time.sleep(5)
    else:
        raise SystemExit('Rollback is still running; wait for completion before deploying')
print('Rollback status:', status)
print('Ready: rerun failed GitHub Actions jobs for run 35565450433.')
