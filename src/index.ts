import * as fs from "fs"
import {debug, getInput, info, setFailed} from "@actions/core"
import {context, getOctokit} from "@actions/github"
import {create as createGlob} from "@actions/glob"
import {DefaultArtifactClient} from "@actions/artifact"
import {gzipSizeFromFile} from "gzip-size"
import {markdownTable} from "markdown-table"
import prettyBytes from "pretty-bytes"
import filesize from "filesize"
import AdmZip from "adm-zip"

const SIZE_COMPARE_HEADING = "## 🚛 [size-compare](https://github.com/numero33/size-branch-compare) report"

type IFileSize = {
    name: string
    relative: string
    full: string
    size: number
    gzip: number
}

async function main() {
    const githubToken = getInput("github-token", {required: true})
    const files = getInput("files")
    const match = getInput("match")
    const matchRegex = new RegExp(match)

    debug("files: " + files)
    debug("match: " + match)
    debug("workspace: " + process.env.GITHUB_WORKSPACE ?? "")

    const {repo, sha, eventName, ref} = context

    // debug("context: " + JSON.stringify(context))

    if (!files) {
        info("No files specified. Skipping")
        return
    }

    const client = getOctokit(githubToken)

    // save current sizes
    let currentFilesSizes = [] as IFileSize[]
    const globber = await createGlob(files, {
        matchDirectories: false,
    })
    debug("globber: " + JSON.stringify(globber))

    const foundFilesList = await globber.glob()
    currentFilesSizes = (await Promise.all(
        foundFilesList.map(async path => ({
            name: path.replace(process.cwd() + "/", ""),
            relative: path.replace(process.cwd(), "."),
            full: path,
            size: fs.statSync(path).size,
            gzip: await gzipSizeFromFile(path),
        })),
    )) as IFileSize[]

    // debug
    // const currentFilesSizesAfterMatch = currentFilesSizes.map(x => ({...x, match: x.full.match(matchRegex)?.slice(1)?.join("")}))
    // debug("currentFilesSizesAfterMatch: " + JSON.stringify(currentFilesSizesAfterMatch, null, 2))

    debug(`Filter "${files.split("\n").join(", ")}" resolved to: ` + foundFilesList.join("\n"))
    debug("Files resolved to sizes: " + JSON.stringify(currentFilesSizes, null, 2))

    const sizes = sumSizes(currentFilesSizes)
    debug("Sizes: " + JSON.stringify(sizes, null, 2))

    info("Ref: " + ref)
    fs.writeFileSync(`${sha}-file_sizes.json`, JSON.stringify(currentFilesSizes))

    const artifactClient = new DefaultArtifactClient()
    const artifactName = `${sha}-file_sizes`
    const artifactFiles = [`${sha}-file_sizes.json`]
    const artifactRootDirectory = "."
    const artifactOptions = {
        compressionLevel: 0,
    }
    const artifact = await artifactClient.uploadArtifact(artifactName, artifactFiles, artifactRootDirectory, artifactOptions)

    debug("Artifact: " + JSON.stringify(artifact))

    // PR comment
    const pullRequests = await client.paginate(client.rest.pulls.list, {
        owner: repo.owner,
        repo: repo.repo,
        state: "open",
    })
    if (!pullRequests || pullRequests.length == 0) {
        info("No pull requests found")
        return
    }
    // const pull_requests = context?.payload?.workflow_run?.pull_requests ?? [];
    // debug("pull_requests: " + JSON.stringify(pullRequests))
    for (const pr of pullRequests) {
        if (pr.draft) {
            debug("Skipping draft PR: " + pr.number)
            continue
        }

        const baseCommits = await client.rest.repos.listCommits({
            repo: repo.repo,
            owner: repo.owner,
            sha: pr.base.ref,
        })
        const baseSha = baseCommits.data[0].sha

        const headCommits = await client.rest.repos.listCommits({
            repo: repo.repo,
            owner: repo.owner,
            sha: pr.head.ref,
        })
        const headSha = headCommits.data[0].sha

        if (sha !== baseSha && sha !== headSha) {
            debug("Skipping PR: " + pr.number + " - sha:" + sha + " baseSha:" + baseSha + " headSha:" + headSha)
            continue
        }

        info("UPDATE PR: " + pr.number)

        let baseFiles = [] as IFileSize[]
        let headFiles = [] as IFileSize[]

        if (baseSha !== sha) baseFiles = await loadCachedFileSizes(client, repo, baseSha)
        else baseFiles = currentFilesSizes
        debug("baseFiles: " + JSON.stringify(baseFiles, null, 2))

        if (headSha !== sha) headFiles = await loadCachedFileSizes(client, repo, headSha)
        else headFiles = currentFilesSizes
        debug("headFiles: " + JSON.stringify(headFiles, null, 2))

        const baseSizes = sumSizes(baseFiles)
        debug("baseSizes: " + JSON.stringify(baseSizes, null, 2))
        const headSizes = sumSizes(headFiles)
        debug("headSizes: " + JSON.stringify(headSizes, null, 2))

        const baseFilesAfterMatch = baseFiles.map(x => ({...x, match: x.full.match(matchRegex)?.slice(1)?.join("") ?? null}))
        const headFilesAfterMatch = headFiles.map(x => ({...x, match: x.full.match(matchRegex)?.slice(1)?.join("") ?? null}))

        // debug("baseFilesAfterMatch: " + JSON.stringify(baseFilesAfterMatch, null, 2))
        // debug("headFilesAfterMatch: " + JSON.stringify(headFilesAfterMatch, null, 2))

        const fileSizeChanges = Array.from(new Set([...baseFilesAfterMatch, ...headFilesAfterMatch].map(x => x.match)))
            .map(x => ({
                base: baseFilesAfterMatch.find(y => y.match === x),
                head: headFilesAfterMatch.find(y => y.match === x),
            }))
            .filter(x => x.base === null || x.head === null || x.base?.size !== x.head?.size)

        debug("fileSizeChanges: " + JSON.stringify(fileSizeChanges, null, 2))

        const commentBody = [
            SIZE_COMPARE_HEADING,
            createCompareLink(repo.owner, repo.repo, baseSha, headSha),
            markdownTable([
                ["File", "+/-", "Base", "Current", "+/- gzip", "Base gzip", "Current gzip"],
                createMarkdownTableChangeRow("Total", baseSizes, headSizes),
                ...fileSizeChanges.map(file =>
                    createMarkdownTableChangeRow(file.base?.name ?? file.head?.name ?? "", file.base ?? {size: 0, gzip: 0}, file.head ?? {size: 0, gzip: 0}),
                ),
            ]),
        ].join("\r\n")

        // debug("commentBody: " + commentBody)

        const previousCommentPromise = fetchPreviousComment(client, repo, {number: pr.number})

        const previousComment = await previousCommentPromise

        if (previousComment) {
            info("Found previous comment. Updating.. " + previousComment.id)
            // debug("Found previous comment in PR:" + JSON.stringify(previousComment, null, 2))
            try {
                await client.rest.issues.updateComment({
                    repo: repo.repo,
                    owner: repo.owner,
                    comment_id: previousComment.id,
                    body: commentBody,
                })
            } catch (error) {
                debug("Error updating comment. This can happen for PR's originating from a fork without write permissions." + error)
            }
        } else {
            info("No previous comment found. Creating new")
            try {
                await client.rest.issues.createComment({
                    repo: repo.repo,
                    owner: repo.owner,
                    issue_number: pr.number,
                    body: commentBody,
                })
            } catch (error) {
                debug("Error creating comment. This can happen for PR's originating from a fork without write permissions." + error)
            }
        }
    }
}

async function fetchPreviousComment(octokit: ReturnType<typeof getOctokit>, repo: {owner: string; repo: string}, pr: {number: number}) {
    const comments = await octokit.rest.issues.listComments({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: pr.number,
    })

    const sizeCompareComment = comments.data.find(comment => comment.body?.startsWith(SIZE_COMPARE_HEADING))

    return sizeCompareComment ?? null
}

function differencePercentage(a: number, b: number): number {
    const v = (Math.abs(a - b) / a) * Math.sign(b - a) * 100
    if (isNaN(v)) return 0
    return v
}

function signedFixedPercent(value: number): string {
    if (value === 0) {
        return "="
    }
    return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`
}

async function loadCachedFileSizes(client: ReturnType<typeof getOctokit>, repo: {owner: string; repo: string}, sha: string): Promise<IFileSize[]> {
    debug("loadCachedFileSizes: " + JSON.stringify(repo) + " sha: " + sha)

    let artifacts = await client.paginate(client.rest.actions.listArtifactsForRepo, {
        owner: repo.owner,
        repo: repo.repo,
    })
    if (!artifacts || artifacts.length == 0) {
        info("No artifacts found for repo: " + repo.owner + "/" + repo.repo)
        return []
    }

    const artifact = artifacts.find(artifact => {
        return artifact.name.startsWith(sha)
    })
    if (!artifact) {
        info("No artifact found for sha: " + sha)
        return []
    }

    const size = filesize.filesize(artifact.size_in_bytes, {base: 10})

    info(`==> Downloading: ${artifact.name}.zip (${size})`)

    let zip
    try {
        zip = await client.rest.actions.downloadArtifact({
            owner: repo.owner,
            repo: repo.repo,
            artifact_id: artifact.id,
            archive_format: "zip",
        })
    } catch (error: any) {
        if (error.message === "Artifact has expired") {
            throw Error("no downloadable artifacts found (expired)")
        } else {
            throw new Error(error.message)
        }
    }

    const adm = new AdmZip(Buffer.from(zip.data as any))

    const rawSizeCompare = adm.readAsText(`${sha}-file_sizes.json`)
    debug("rawSizeCompare: " + rawSizeCompare.toString())

    try {
        return JSON.parse(rawSizeCompare.toString())
    } catch (error) {
        debug("Error parsing compare files" + error)
    }
    return []
}

function sumSizes(files: IFileSize[]): {size: number; gzip: number} {
    return (files ?? []).reduce((acc, val) => ({size: acc.size + val.size, gzip: acc.gzip + val.gzip}), {size: 0, gzip: 0})
}

function createCompareLink(owner: string, repo: string, baseSha: string, headSha: string): string {
    const link = `https://github.com/${owner}/${repo}/compare/${baseSha}...${headSha}`
    return `Comparing [${baseSha.slice(0, 8)}...${headSha.slice(0, 8)}](${link})`
}

function createMarkdownTableChangeRow(name: string, baseSizes: {size: number; gzip: number}, headSizes: {size: number; gzip: number}): string[] {
    return [
        name,
        `${signedFixedPercent(differencePercentage(baseSizes.size, headSizes.size))} (${prettyBytes(headSizes.size - baseSizes.size, {
            signed: true,
        })})`,
        prettyBytes(baseSizes.size),
        prettyBytes(headSizes.size),
        `${signedFixedPercent(differencePercentage(baseSizes.gzip, headSizes.gzip))} (${prettyBytes(headSizes.gzip - baseSizes.gzip, {
            signed: true,
        })})`,
        prettyBytes(baseSizes.gzip),
        prettyBytes(headSizes.gzip),
    ]
}

main().catch(error => {
    if (error instanceof Error) {
        setFailed(error.message)
    } else {
        setFailed(String(error))
    }
})
