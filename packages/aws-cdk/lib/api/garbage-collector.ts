/* eslint-disable no-console */
import * as path from 'path';
import * as cxapi from '@aws-cdk/cx-api';
import { ECR } from 'aws-sdk';
import { ISDK, SdkProvider } from './aws-auth';
import { Mode } from './aws-auth/credentials';
import { ToolkitInfo } from './toolkit-info';

interface GarbageCollectorProps {
  dryRun: boolean;

  /**
   * The environment to deploy this stack in
   *
   * The environment on the stack artifact may be unresolved, this one
   * must be resolved.
   */
  resolvedEnvironment: cxapi.Environment;

  /**
    * SDK provider (seeded with default credentials)
    *
    * Will exclusively be used to assume publishing credentials (which must
    * start out from current credentials regardless of whether we've assumed an
    * action role to touch the stack or not).
    *
    * Used for the following purposes:
    *
    * - Publish legacy assets.
    * - Upload large CloudFormation templates to the staging bucket.
    */
  sdkProvider: SdkProvider;
}

export class GarbageCollector {
  private hashes: Set<string> = new Set();
  public constructor(private readonly props: GarbageCollectorProps) {
  }

  public async garbageCollect() {
    const totalStart = Date.now();
    const sdk = (await this.props.sdkProvider.forEnvironment(this.props.resolvedEnvironment, Mode.ForWriting)).sdk;
    console.log('Collecting Hashes');
    let start = Date.now();
    await this.collectHashes(sdk);
    console.log('Finished collecting hashes: ', formatTime(start), ' seconds');
    console.log('Getting bootstrap bucket');
    start = Date.now();
    const bucket = await this.getBootstrapBucket(sdk);
    console.log('Got bootstrap bucket:', formatTime(start), 'seconds');
    console.log('Getting bootstrap repositories');
    start = Date.now();
    const repos = await this.getBootstrapRepositories(sdk);
    console.log('Got bootstrapped repositories:', formatTime(start), 'seconds');
    console.log(bucket, repos);

    console.log('Collecting isolated objects');
    start = Date.now();
    await this.collectIsolatedObjects(sdk, bucket);
    console.log('Collected isolated buckets:', formatTime(start), 'seconds');
    console.log('Collecting isolated images');
    start = Date.now();
    await this.collectIsolatedImages(sdk, repos);
    console.log('Collected isolated images:', formatTime(start), 'seconds');
    console.log('Total Garbage Collection time:', formatTime(totalStart), 'seconds');
  }

  private async collectHashes(sdk: ISDK) {
    const cfn = sdk.cloudFormation();
    const stackNames: string[] = [];
    await paginateSdkCall(async (nextToken) => {
      const response = await cfn.listStacks({ NextToken: nextToken }).promise();
      stackNames.push(...(response.StackSummaries ?? []).map(s => s.StackId ?? s.StackName));
      return response.NextToken;
    });

    console.log('num stacks:', stackNames.length);

    // TODO: gracefully fail this
    for (const stack of stackNames) {
      const template = await cfn.getTemplate({
        StackName: stack,
      }).promise();

      const templateHashes = template.TemplateBody?.match(/[a-f0-9]{64}/g);
      templateHashes?.forEach(this.hashes.add, this.hashes);
    }

    console.log('num hashes:', this.hashes.size);
  }

  private async collectIsolatedObjects(sdk: ISDK, bucket: string) {
    const s3 = sdk.s3();
    const isolatedObjects: string[] = [];
    await paginateSdkCall(async (nextToken) => {
      const response = await s3.listObjectsV2({
        Bucket: bucket,
        ContinuationToken: nextToken,
      }).promise();
      response.Contents?.forEach((obj) => {
        const hash = getHash(obj.Key ?? '');
        if (!this.hashes.has(hash)) {
          isolatedObjects.push(hash);
        }
      });
      return response.NextContinuationToken;
    });

    console.log(isolatedObjects);
    console.log('num isolated', isolatedObjects.length);

    function getHash(file: string) {
      return path.basename(file, path.extname(file));
    }
  }

  private async collectIsolatedImages(sdk: ISDK, repos: string[]) {
    const ecr = sdk.ecr();
    const isolatedImages: string[] = [];
    for (const repo of repos) {
      await paginateSdkCall(async (nextToken) => {
        const response = await ecr.listImages({
          repositoryName: repo,
          nextToken: nextToken,
        }).promise();
        const images: Record<string, string[]> = {};
        // map unique image digest to (possibly multiple) tags
        for (const image of response.imageIds ?? []) {
          if (!image.imageDigest || !image.imageTag) { continue; }
          if (!images[image.imageDigest]) {
            images[image.imageDigest] = [];
          }
          images[image.imageDigest].push(image.imageTag);
        }
        // make sure all tags of an image are isolated
        for (const tags of Object.values(images)) {
          let del = true;
          for (const tag of tags) {
            if (this.hashes.has(tag)) {
              del = false;
            }
          }
          if (del) {
            isolatedImages.push(tags[0]);
          }
        }
        return response.nextToken;
      });
    }

    console.log(isolatedImages);
    console.log('num isolated', isolatedImages.length);
  }

  private async getBootstrapBucket(sdk: ISDK) {
    // maybe use tags like for ecr
    const info = await ToolkitInfo.lookup(this.props.resolvedEnvironment, sdk, undefined);
    return info.bucketName;
  }

  private async getBootstrapRepositories(sdk: ISDK) {
    const ecr = sdk.ecr();
    let repos: ECR.RepositoryList = [];
    await paginateSdkCall(async (nextToken) => {
      const response = await ecr.describeRepositories({ nextToken: nextToken }).promise();
      repos = response.repositories ?? [];
      return response.nextToken;
    });
    const bootstrappedRepos: string[] = [];
    for (const repo of repos ?? []) {
      if (!repo.repositoryArn || !repo.repositoryName) { continue; }
      const tags = await ecr.listTagsForResource({
        resourceArn: repo.repositoryArn,
      }).promise();
      for (const tag of tags.tags ?? []) {
        if (tag.Key === 'awscdk:asset' && tag.Value === 'true') {
          bootstrappedRepos.push(repo.repositoryName);
        }
      }
    }
    return bootstrappedRepos;
  }
}

async function paginateSdkCall(cb: (nextToken?: string) => Promise<string | undefined>) {
  let finished = false;
  let nextToken: string | undefined;
  while (!finished) {
    nextToken = await cb(nextToken);
    if (nextToken === undefined) {
      finished = true;
    }
  }
}

function formatTime(start: number): number {
  return (Date.now() - start) / 1000;
}