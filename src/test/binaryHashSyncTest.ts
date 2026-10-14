import { SyncEngine, TestUri } from './nativeSyncFixture';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { cleanTemporaryWorkspaces, createTemporaryWorkspace } from './temporaryWorkspace';
import { runStandaloneTest } from './standaloneRunner';

const blobHash = (bytes: Buffer) => createHash('sha1')
    .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

async function check(options: {
    hash?: unknown; local?: Buffer; remote?: Buffer; expectedDownloads: number;
    stale?: boolean; doc?: boolean; pending?: boolean; dirty?: boolean;
    oldHash?: string; replacementId?: string;
}): Promise<void> {
    const directory = await createTemporaryWorkspace('binary-hash-sync');
    const remote = options.remote ?? Buffer.from([0, 255, 128, 65]);
    const filename = options.doc ? 'main.tex' : 'figure.png';
    const localPath = path.join(directory, filename);
    if (options.local !== undefined) await fs.writeFile(localPath, options.local);
    const entity = { _id: options.replacementId ?? 'file', name: filename, hash: options.hash };
    const project = { _id: 'project', name: 'fixture', rootFolder: [{ _id: 'root', name: '',
        docs: options.doc ? [entity] : [], fileRefs: options.doc ? [] : [entity], folders: [] }] };
    let downloads = 0;
    const api = { dispose() {}, async getProjectDetails() {
        return { type: 'success', projectData: options.stale ? {} : {
            projectId: 'project', rootFolder: project.rootFolder,
        } };
    }, async getFile() { downloads++; return { type: 'success', content: remote }; } };
    const settings = {
        getWorkspaceFolder: () => TestUri.file(directory),
        getSettings: () => ({ serverUrl: 'https://example.invalid', projectId: 'project', autoSync: false }),
        getFilePath: (relative: string) => TestUri.file(path.join(directory, relative)),
        getRelativePath: (uri: InstanceType<typeof TestUri>) => '/' + path.relative(directory, uri.fsPath),
        async updateLastSynced() {},
    };
    const engine: any = new SyncEngine(api, settings);
    try {
        engine.project = project;
        engine.buildFileTree(project);
        engine.socket = { isConnected: true, disconnect() {}, async leaveDoc() {},
            async joinDoc() { downloads++; return { lines: remote.toString().split('\n'), version: 1 }; } };
        engine.shouldSync = () => true;
        if (options.oldHash) engine.getBaseHashes().set('/' + filename, options.oldHash);
        if (options.pending) {
            engine.stateStore = { entries: new Map([['/' + filename, { intent: { kind: 'replace' } }]]),
                put() {}, async flush() {} };
            engine.recoverReplacementIntents = async () => {};
        }
        if (options.dirty) engine.getOpenTextDocument = () => ({
            isDirty: true, version: 1, getText: () => 'unsaved', eol: 1,
        });
        await engine.performPullAll(true);
        assert.equal(downloads, options.expectedDownloads, JSON.stringify(options));
        if (options.expectedDownloads === 0) {
            assert.equal(engine.getBaseHashes().get('/' + filename),
                createHash('sha256').update(remote).digest('hex'), 'retain SHA-256 baseline');
        }
        if (options.local !== undefined) {
            const expected = options.oldHash ? remote : options.local;
            assert.deepEqual(await fs.readFile(localPath), expected, 'preserve normal reconciliation');
        }
    } finally { engine.disconnect(); }
}

async function run(): Promise<void> {
    const bytes = Buffer.from([0, 255, 128, 65]);
    const hash = blobHash(bytes);
    await check({ hash, local: bytes, expectedDownloads: 0 });
    await check({ hash: hash.toUpperCase(), local: bytes, expectedDownloads: 0 });
    await check({ hash, local: bytes, replacementId: 'replacement', expectedDownloads: 0 });
    for (const invalid of [undefined, '', 'invalid', 'a'.repeat(64), 123]) {
        await check({ hash: invalid, local: bytes, expectedDownloads: 1 });
    }
    await check({ hash, expectedDownloads: 1 }); // Missing local copy must be downloaded.
    await check({ hash, local: Buffer.from('local change'), expectedDownloads: 1 });
    const old = Buffer.from('old image');
    await check({ hash, local: old, oldHash: createHash('sha256').update(old).digest('hex'), expectedDownloads: 1 });
    await check({ hash, local: bytes, stale: true, expectedDownloads: 1 });
    await check({ hash, local: bytes, pending: true, expectedDownloads: 1 });
    await check({ hash, local: bytes, dirty: true, expectedDownloads: 1 });
    const text = Buffer.from('text');
    await check({ hash: blobHash(text), doc: true, local: text, remote: text, expectedDownloads: 1 });
    await check({ hash: blobHash(Buffer.alloc(0)), local: Buffer.alloc(0), remote: Buffer.alloc(0), expectedDownloads: 0 });
    console.log('Binary hash synchronization regression tests passed (16 cases).');
}

runStandaloneTest(async () => { try { await run(); } finally { await cleanTemporaryWorkspaces(); } });
