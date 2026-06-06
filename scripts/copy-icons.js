/**
 * copy-icons.js
 * Copies official AWS SVG icons from node_modules/aws-svg-icons/lib/
 * into media/aws-icons/ for use in the StepLens VS Code extension.
 *
 * Run via: node scripts/copy-icons.js
 */

const fs   = require('fs');
const path = require('path');

const ROOT     = path.join(__dirname, '..');
const SRC_BASE = path.join(ROOT, 'node_modules', 'aws-svg-icons', 'lib');
const OUT_DIR  = path.join(ROOT, 'media', 'aws-icons');

const ICON_MAP = {
  'lambda':           'Architecture-Service-Icons_07302021/Arch_Compute/64/Arch_AWS-Lambda_64.svg',
  'states':           'Architecture-Service-Icons_07302021/Arch_App-Integration/Arch_64/Arch_AWS-Step-Functions_64.svg',
  'ecs':              'Architecture-Service-Icons_07302021/Arch_Containers/64/Arch_Amazon-Elastic-Container-Service_64.svg',
  'fargate':          'Architecture-Service-Icons_07302021/Arch_Compute/64/Arch_AWS-Fargate_64.svg',
  'batch':            'Architecture-Service-Icons_07302021/Arch_Compute/64/Arch_AWS-Batch_64.svg',
  'dynamodb':         'Architecture-Service-Icons_07302021/Arch_Database/64/Arch_Amazon-DynamoDB_64.svg',
  's3':               'Architecture-Service-Icons_07302021/Arch_Storage/64/Arch_Amazon-Simple-Storage-Service_64.svg',
  'athena':           'Architecture-Service-Icons_07302021/Arch_Analytics/Arch_64/Arch_Amazon-Athena_64.svg',
  'glue':             'Architecture-Service-Icons_07302021/Arch_Analytics/Arch_64/Arch_AWS-Glue_64.svg',
  'databrew':         'Architecture-Service-Icons_07302021/Arch_Analytics/Arch_64/Arch_AWS-Glue-DataBrew_64.svg',
  'kinesis':          'Architecture-Service-Icons_07302021/Arch_Analytics/Arch_64/Arch_Amazon-Kinesis_64.svg',
  'firehose':         'Architecture-Service-Icons_07302021/Arch_Analytics/Arch_64/Arch_Amazon-Kinesis-Firehose_64.svg',
  'elasticmapreduce': 'Architecture-Service-Icons_07302021/Arch_Analytics/Arch_64/Arch_Amazon-EMR_64.svg',
  'emr-containers':   'Architecture-Service-Icons_07302021/Arch_Analytics/Arch_64/Arch_Amazon-EMR_64.svg',
  'emr-serverless':   'Architecture-Service-Icons_07302021/Arch_Analytics/Arch_64/Arch_Amazon-EMR_64.svg',
  'appsync':          'Architecture-Service-Icons_07302021/Arch_App-Integration/Arch_64/Arch_AWS-AppSync_64.svg',
  'apigateway':       'Architecture-Service-Icons_07302021/Arch_App-Integration/Arch_64/Arch_Amazon-API-Gateway_64.svg',
  'events':           'Architecture-Service-Icons_07302021/Arch_App-Integration/Arch_64/Arch_Amazon-EventBridge_64.svg',
  'eventbridge':      'Architecture-Service-Icons_07302021/Arch_App-Integration/Arch_64/Arch_Amazon-EventBridge_64.svg',
  'scheduler':        'Architecture-Service-Icons_07302021/Arch_App-Integration/Arch_64/Arch_Amazon-EventBridge_64.svg',
  'sns':              'Architecture-Service-Icons_07302021/Arch_App-Integration/Arch_64/Arch_Amazon-Simple-Notification-Service_64.svg',
  'sqs':              'Architecture-Service-Icons_07302021/Arch_App-Integration/Arch_64/Arch_Amazon-Simple-Queue-Service_64.svg',
  'sagemaker':        'Architecture-Service-Icons_07302021/Arch_Machine-Learning/64/Arch_Amazon-SageMaker_64.svg',
  'comprehend':       'Architecture-Service-Icons_07302021/Arch_Machine-Learning/64/Arch_Amazon-Comprehend_64.svg',
  'rekognition':      'Architecture-Service-Icons_07302021/Arch_Machine-Learning/64/Arch_Amazon-Rekognition_64.svg',
  'textract':         'Architecture-Service-Icons_07302021/Arch_Machine-Learning/64/Arch_Amazon-Textract_64.svg',
  'translate':        'Architecture-Service-Icons_07302021/Arch_Machine-Learning/64/Arch_Amazon-Translate_64.svg',
  'polly':            'Architecture-Service-Icons_07302021/Arch_Machine-Learning/64/Arch_Amazon-Polly_64.svg',
  'transcribe':       'Architecture-Service-Icons_07302021/Arch_Machine-Learning/64/Arch_Amazon-Transcribe_64.svg',
  'lex':              'Architecture-Service-Icons_07302021/Arch_Machine-Learning/64/Arch_Amazon-Lex_64.svg',
  'cloudformation':   'Architecture-Service-Icons_07302021/Arch_Management-Governance/64/Arch_AWS-CloudFormation_64.svg',
  'ssm':              'Architecture-Service-Icons_07302021/Arch_Management-Governance/64/Arch_AWS-Systems-Manager_64.svg',
  'secretsmanager':   'Architecture-Service-Icons_07302021/Arch_Security-Identity-Compliance/64/Arch_AWS-Secrets-Manager_64.svg',
  'mediaconvert':     'Architecture-Service-Icons_07302021/Arch_Media-Services/64/Arch_AWS-Elemental-MediaConvert_64.svg',
  'iot':              'Architecture-Service-Icons_07302021/Arch_Internet-of-Things/64/Arch_AWS-IoT-Core_64.svg',
  'codebuild':        'Architecture-Service-Icons_07302021/Arch_Developer-Tools/64/Arch_AWS-CodeBuild_64.svg',
};

// Create output directory if it doesn't exist
fs.mkdirSync(OUT_DIR, { recursive: true });

let copied  = 0;
let skipped = 0;

for (const [service, relPath] of Object.entries(ICON_MAP)) {
  const src  = path.join(SRC_BASE, relPath);
  const dest = path.join(OUT_DIR, `${service}.svg`);

  if (!fs.existsSync(src)) {
    console.warn(`[copy-icons] WARN: source not found — ${src}`);
    skipped++;
    continue;
  }

  fs.copyFileSync(src, dest);
  copied++;
}

console.log(`[copy-icons] Done — ${copied} icon(s) copied to media/aws-icons/, ${skipped} skipped.`);
