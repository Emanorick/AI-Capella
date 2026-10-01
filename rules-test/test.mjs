// The Firestore rules (../firestore.rules), checked against the emulator: npm install && npm test.
// Seeds two ensembles and plays through joining, the separation of songs and sessions, setting up
// an unguarded ensemble, attempts to take over or repoint codes, and changing a code.
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, query, where, serverTimestamp } from 'firebase/firestore';
import fs from 'fs';
const env = await initializeTestEnvironment({ projectId: 'demo-ls', firestore: { rules: fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8085 } });
const C_NNB = 'a'.repeat(64), C_RM = 'b'.repeat(64);
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'ensembleCodes', C_NNB), { ensemble: 'nnb' });
  await setDoc(doc(db, 'ensembles', 'nnb'), { codeId: C_NNB, name: 'Ensemble n.n.b.' });
  await setDoc(doc(db, 'songs', 'a'), { ensemble: 'nnb', title: 'A', importedAt: 1 });
  await setDoc(doc(db, 'songs', 'b'), { ensemble: 'rm', title: 'B', importedAt: 2 });
  await setDoc(doc(db, 'songs', 'legacy'), { title: 'L', importedAt: 0 });
  await setDoc(doc(db, 'config', 'access'), { pinHash: 'x' });
});
let pass = 0, fail = 0;
async function check(name, expect, fn) {
  try { await (expect ? assertSucceeds(fn()) : assertFails(fn())); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.log('FAIL', name, e.message?.slice(0, 160)); }
}
const alice = env.authenticatedContext('alice').firestore();
const bob = env.authenticatedContext('bob').firestore();
const carol = env.authenticatedContext('carol').firestore();
const anon = env.unauthenticatedContext().firestore();
const songsOf = (db, e) => getDocs(query(collection(db, 'songs'), where('ensemble', '==', e)));

await check('signed out cannot fetch a code', false, () => getDoc(doc(anon, 'ensembleCodes', C_NNB)));
await check('fetch a code by its id', true, () => getDoc(doc(alice, 'ensembleCodes', C_NNB)));
await check('cannot list codes', false, () => getDocs(collection(alice, 'ensembleCodes')));
await check('no songs before joining', false, () => songsOf(alice, 'nnb'));
await check('cannot read the old PIN hash', false, () => getDoc(doc(alice, 'config', 'access')));
await check('join with a wrong code', false, () => setDoc(doc(alice, 'members', 'alice', 'ensembles', 'nnb'), { code: 'c'.repeat(64) }));
await check('join another ensemble with this code', false, () => setDoc(doc(alice, 'members', 'alice', 'ensembles', 'rm'), { code: C_NNB }));
await check('join with the code', true, () => setDoc(doc(alice, 'members', 'alice', 'ensembles', 'nnb'), { code: C_NNB, joinedAt: serverTimestamp() }));
await check('cannot add someone else', false, () => setDoc(doc(alice, 'members', 'bob', 'ensembles', 'nnb'), { code: C_NNB }));
await check('cannot read someone else\'s memberships', false, () => getDoc(doc(alice, 'members', 'bob', 'ensembles', 'nnb')));
await check('own ensemble\'s songs', true, () => songsOf(alice, 'nnb'));
const n = (await songsOf(alice, 'nnb')).size;
console.log('  songs seen:', n);
await check('other ensemble\'s songs', false, () => songsOf(alice, 'rm'));
await check('all songs at once', false, () => getDocs(collection(alice, 'songs')));
await check('other ensemble\'s song by id', false, () => getDoc(doc(alice, 'songs', 'b')));
await check('unfiled song by id', false, () => getDoc(doc(alice, 'songs', 'legacy')));
await check('add a song to own ensemble', true, () => setDoc(doc(alice, 'songs', 'new'), { ensemble: 'nnb', title: 'N', importedAt: 3 }));
await check('add a song to another', false, () => setDoc(doc(alice, 'songs', 'new2'), { ensemble: 'rm', title: 'N', importedAt: 3 }));
await check('rename own song', true, () => updateDoc(doc(alice, 'songs', 'a'), { title: 'A2', 'partNameOverrides.P1': 'S' }));
await check('move to an ensemble not joined', false, () => updateDoc(doc(alice, 'songs', 'a'), { ensemble: 'rm' }));
await check('change another ensemble\'s song', false, () => updateDoc(doc(alice, 'songs', 'b'), { title: 'x' }));
await check('delete another ensemble\'s song', false, () => deleteDoc(doc(alice, 'songs', 'b')));
await check('own session', true, () => setDoc(doc(alice, 'sessions', 'live'), { playing: false }, { merge: true }));
await check('read own session', true, () => getDoc(doc(alice, 'sessions', 'live')));
await check('other ensemble\'s session', false, () => getDoc(doc(alice, 'sessions', 'live-rm')));
await check('clock ping', true, () => setDoc(doc(alice, 'sessions', 'clockPing_dev1'), { ts: serverTimestamp() }));
await check('read own ensemble', true, () => getDoc(doc(alice, 'ensembles', 'nnb')));
await check('rename own ensemble', true, () => setDoc(doc(alice, 'ensembles', 'nnb'), { name: 'Neu' }, { merge: true }));
// Relativ männlich: unguarded until its first code
await check('read an unguarded ensemble', true, () => getDoc(doc(alice, 'ensembles', 'rm')));
await check('first code for an unguarded ensemble', true, () => setDoc(doc(alice, 'ensembleCodes', C_RM), { ensemble: 'rm' }));
await check('join it', true, () => setDoc(doc(alice, 'members', 'alice', 'ensembles', 'rm'), { code: C_RM }));
await check('guard it', true, () => setDoc(doc(alice, 'ensembles', 'rm'), { codeId: C_RM }, { merge: true }));
await check('now its songs', true, () => songsOf(alice, 'rm'));
await check('move a song between own ensembles', true, () => updateDoc(doc(alice, 'songs', 'a'), { ensemble: 'rm' }));
await check('rm session', true, () => getDoc(doc(alice, 'sessions', 'live-rm')));
// bob is only in n.n.b.
await check('bob joins nnb', true, () => setDoc(doc(bob, 'members', 'bob', 'ensembles', 'nnb'), { code: C_NNB }));
await check('bob: no second code for a guarded ensemble', false, () => setDoc(doc(bob, 'ensembleCodes', 'd'.repeat(64)), { ensemble: 'rm' }));
await check('bob: cannot repoint a code', false, () => setDoc(doc(bob, 'ensembleCodes', C_RM), { ensemble: 'nnb' }));
await check('bob: cannot delete another\'s code', false, () => deleteDoc(doc(bob, 'ensembleCodes', C_RM)));
await check('bob: cannot read a guarded ensemble', false, () => getDoc(doc(bob, 'ensembles', 'rm')));
await check('bob: cannot rename it', false, () => setDoc(doc(bob, 'ensembles', 'rm'), { name: 'x' }, { merge: true }));
await check('bob: extra fields on a code', false, () => setDoc(doc(bob, 'ensembleCodes', 'e'.repeat(64)), { ensemble: 'nnb', admin: true }));
// changing n.n.b.'s code
const C_NNB2 = 'f'.repeat(64);
await check('new code', true, () => setDoc(doc(alice, 'ensembleCodes', C_NNB2), { ensemble: 'nnb' }));
await check('retire the old one', true, () => deleteDoc(doc(alice, 'ensembleCodes', C_NNB)));
await check('old code no longer opens it', false, () => setDoc(doc(carol, 'members', 'carol', 'ensembles', 'nnb'), { code: C_NNB }));
await check('new code does', true, () => setDoc(doc(carol, 'members', 'carol', 'ensembles', 'nnb'), { code: C_NNB2 }));
await check('bob stays in', true, () => songsOf(bob, 'nnb'));
console.log(`\n${pass} passed, ${fail} failed`);
await env.cleanup();
process.exit(fail ? 1 : 0);
