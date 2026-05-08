import { S3Client, PutBucketCorsCommand } from "@aws-sdk/client-s3";

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function parseOrigins(): string[] {
  const raw = (process.env.S3_CORS_ALLOWED_ORIGINS || "").trim();
  if (raw) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // Default for this project.
  return ["https://cielpk.com", "https://www.cielpk.com"];
}

async function main() {
  const region = requireEnv("AWS_REGION");
  const bucket = requireEnv("AWS_S3_BUCKET");
  const origins = parseOrigins();

  const s3 = new S3Client({ region });

  const command = new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: origins,
          AllowedMethods: ["PUT", "GET", "HEAD"],
          AllowedHeaders: ["*"],
          ExposeHeaders: ["ETag", "x-amz-request-id", "x-amz-id-2"],
          MaxAgeSeconds: 3000,
        },
      ],
    },
  });

  await s3.send(command);
  console.log(`Updated S3 CORS for bucket ${bucket} in ${region}`);
  console.log(`Allowed origins: ${origins.join(", ")}`);
}

main().catch((e) => {
  console.error("Failed to update S3 CORS:", e);
  process.exit(1);
});

