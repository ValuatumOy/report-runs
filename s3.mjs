import { createHash, createHmac } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Minimal signed S3 GET. The AWS CLI is not installed in every environment the
 * registry runs in (the cloud sandbox has credentials but no `aws` binary), so
 * fetching an object is done here with SigV4 and node's crypto — no CLI, no SDK.
 */

const REGION = process.env.AWS_DEFAULT_REGION ?? 'eu-west-1'

/** Env first, then the named profile in ~/.aws/credentials. */
export function credentials(profile = process.env.AWS_PROFILE ?? 'default') {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    }
  }
  const file = join(homedir(), '.aws', 'credentials')
  if (!existsSync(file)) return null
  let current = null
  const found = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const section = /^\[(.+)\]\s*$/.exec(line.trim())
    if (section) {
      current = section[1]
      continue
    }
    const kv = /^(\w+)\s*=\s*(.+)$/.exec(line.trim())
    if (kv && current === profile) found[kv[1]] = kv[2]
  }
  return found.aws_access_key_id
    ? {
        accessKeyId: found.aws_access_key_id,
        secretAccessKey: found.aws_secret_access_key,
        sessionToken: found.aws_session_token,
      }
    : null
}

const sha256 = (v) => createHash('sha256').update(v).digest('hex')
const hmac = (key, v) => createHmac('sha256', key).update(v).digest()

/**
 * GETs `key` from `bucket`. Resolves to a Buffer, or null when the object is
 * absent (404) — callers treat "not in this bucket" as a normal outcome.
 * Everything else throws, including 403: a rejected key looks exactly like a
 * missing object to the caller otherwise, which once made a cloud run report
 * "no artifacts" when the real answer was InvalidAccessKeyId.
 */
export async function getObject(bucket, key, creds = credentials()) {
  if (!creds) throw new Error('no AWS credentials (set AWS_ACCESS_KEY_ID/SECRET or AWS_PROFILE)')
  const host = `${bucket}.s3.${REGION}.amazonaws.com`
  const path = '/' + key.split('/').map(encodeURIComponent).join('/')
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const date = now.slice(0, 8)
  const payload = sha256('')

  const headers = {
    host,
    'x-amz-content-sha256': payload,
    'x-amz-date': now,
    ...(creds.sessionToken ? { 'x-amz-security-token': creds.sessionToken } : {}),
  }
  const signedHeaders = Object.keys(headers).sort().join(';')
  const canonical = [
    'GET',
    path,
    '',
    ...Object.keys(headers)
      .sort()
      .map((h) => `${h}:${headers[h]}`),
    '',
    signedHeaders,
    payload,
  ].join('\n')

  const scope = `${date}/${REGION}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256(canonical)].join('\n')
  const signature = hmac(
    hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, date), REGION), 's3'), 'aws4_request'),
    toSign,
  ).toString('hex')

  const res = await fetch(`https://${host}${path}`, {
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const body = await res.text()
    const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? ''
    throw new Error(`s3 ${bucket}/${key}: ${res.status} ${code} ${body.slice(0, 200).replace(/\s+/g, ' ')}`)
  }
  return Buffer.from(await res.arrayBuffer())
}
