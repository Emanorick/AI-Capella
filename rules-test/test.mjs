// The Firestore rules (../firestore.rules), checked against the emulator: npm install && npm test.
// Seeds two ensembles and plays through joining, the separation of songs and sessions, setting up
// an unguarded ensemble, attempts to take over or repoint codes, and changing a code.
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, query, where, serverTimestamp } from 'firebase/firestore';
import fs from 'fs';
const env = await initializeTestEnvironment({ projectId: 'demo-ls', firestore: { rules: fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8085 } });
await env.clearFirestore(); // a fresh start, also against an emulator that is already running
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
await check('own clock ping', true, () => setDoc(doc(alice, 'sessions', 'clockPing_alice'), { ts: serverTimestamp() }));
await check('read own clock ping', true, () => getDoc(doc(alice, 'sessions', 'clockPing_alice')));
await check('someone else\'s clock ping', false, () => setDoc(doc(bob, 'sessions', 'clockPing_alice'), { ts: serverTimestamp() }));
await check('read someone else\'s clock ping', false, () => getDoc(doc(bob, 'sessions', 'clockPing_alice')));
await check('clock ping by device id', false, () => setDoc(doc(alice, 'sessions', 'clockPing_dev1'), { ts: serverTimestamp() }));
await check('clock ping with other data', false, () => setDoc(doc(alice, 'sessions', 'clockPing_alice'), { ts: serverTimestamp(), junk: 'x'.repeat(100) }));
await check('signed out clock ping', false, () => setDoc(doc(anon, 'sessions', 'clockPing_alice'), { ts: serverTimestamp() }));
await check('read own ensemble', true, () => getDoc(doc(alice, 'ensembles', 'nnb')));
// Leaders: n.n.b. has no leaders' code yet -- a member sets the first and leads it.
const L_NNB = '1'.repeat(64), L_NNB2 = '2'.repeat(64);
await check('member cannot rename before leading', false, () => setDoc(doc(alice, 'ensembles', 'nnb'), { name: 'Neu' }, { merge: true }));
await check('member cannot change the code before leading', false, () => setDoc(doc(alice, 'ensembleCodes', '3'.repeat(64)), { ensemble: 'nnb' }));
await check('not a member: no leaders\' code', false, () => setDoc(doc(carol, 'leaderCodes', L_NNB), { ensemble: 'nnb' }));
await check('first leaders\' code', true, () => setDoc(doc(alice, 'leaderCodes', L_NNB), { ensemble: 'nnb' }));
await check('lead with it', true, () => setDoc(doc(alice, 'leaders', 'alice', 'ensembles', 'nnb'), { code: L_NNB }));
await check('cannot lead with the members\' code', false, () => setDoc(doc(alice, 'leaders', 'alice', 'ensembles', 'nnb'), { code: C_NNB }));
await check('record it', true, () => setDoc(doc(alice, 'ensembles', 'nnb'), { leaderCodeId: L_NNB }, { merge: true }));
await check('cannot list leaders\' codes', false, () => getDocs(collection(alice, 'leaderCodes')));
await check('rename own ensemble', true, () => setDoc(doc(alice, 'ensembles', 'nnb'), { name: 'Neu' }, { merge: true }));
await check('cannot drop the leaders\' code', false, () => setDoc(doc(alice, 'ensembles', 'nnb'), { codeId: C_NNB, name: 'Neu' }));
await check('cannot drop its code', false, () => setDoc(doc(alice, 'ensembles', 'nnb'), { name: 'Neu' }));
await check('cannot point it at no code', false, () => setDoc(doc(alice, 'ensembles', 'nnb'), { codeId: '9'.repeat(64) }, { merge: true }));
await check('cannot delete it', false, () => deleteDoc(doc(alice, 'ensembles', 'nnb')));
await check('made-up ensemble: no code', false, () => setDoc(doc(carol, 'ensembleCodes', '7'.repeat(64)), { ensemble: 'spam1' }));
await check('made-up ensemble: not readable', false, () => getDoc(doc(carol, 'ensembles', 'spam1')));
await check('made-up ensemble: no session', false, () => getDoc(doc(carol, 'sessions', 'live-spam1')));
await check('a code that is no hash', false, () => setDoc(doc(alice, 'ensembleCodes', 'x'), { ensemble: 'nnb' }));
// Relativ männlich: unguarded until its first code
await check('read an unguarded ensemble', true, () => getDoc(doc(alice, 'ensembles', 'rm')));
await check('cannot guard it with no code', false, () => setDoc(doc(alice, 'ensembles', 'rm'), { codeId: C_RM }, { merge: true }));
await check('first code for an unguarded ensemble', true, () => setDoc(doc(alice, 'ensembleCodes', C_RM), { ensemble: 'rm' }));
await check('join it', true, () => setDoc(doc(alice, 'members', 'alice', 'ensembles', 'rm'), { code: C_RM }));
await check('guard it', true, () => setDoc(doc(alice, 'ensembles', 'rm'), { codeId: C_RM }, { merge: true }));
await check('now its songs', true, () => songsOf(alice, 'rm'));
await check('move a song between own ensembles', true, () => updateDoc(doc(alice, 'songs', 'a'), { ensemble: 'rm' }));
await check('rm session', true, () => getDoc(doc(alice, 'sessions', 'live-rm')));
// bob is only in n.n.b.
await check('bob joins nnb', true, () => setDoc(doc(bob, 'members', 'bob', 'ensembles', 'nnb'), { code: C_NNB }));
await check('bob: no second first leaders\' code', false, () => setDoc(doc(bob, 'leaderCodes', '4'.repeat(64)), { ensemble: 'nnb' }));
await check('bob: cannot lead with no code', false, () => setDoc(doc(bob, 'leaders', 'bob', 'ensembles', 'nnb'), { code: '4'.repeat(64) }));
await check('bob: cannot rename', false, () => setDoc(doc(bob, 'ensembles', 'nnb'), { name: 'bob' }, { merge: true }));
await check('bob: cannot change the code', false, () => setDoc(doc(bob, 'ensembleCodes', '5'.repeat(64)), { ensemble: 'nnb' }));
await check('bob: cannot retire the code', false, () => deleteDoc(doc(bob, 'ensembleCodes', C_NNB)));
await check('bob: cannot repoint the ensemble', false, () => setDoc(doc(bob, 'ensembles', 'nnb'), { codeId: C_NNB }, { merge: true }));
await check('bob: songs as before', true, () => songsOf(bob, 'nnb'));
await check('bob: cannot move a song in the list', false, () => updateDoc(doc(bob, 'songs', 'new'), { sortKey: 5 }));
await check('bob: cannot add a song with a place', false, () => setDoc(doc(bob, 'songs', 'bobs'), { ensemble: 'nnb', title: 'B', importedAt: 9, sortKey: 1 }));
await check('bob: still renames a song', true, () => updateDoc(doc(bob, 'songs', 'new'), { title: 'Renamed' }));
await check('a leader moves a song in the list', true, () => updateDoc(doc(alice, 'songs', 'new'), { sortKey: 5 }));
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
await check('ensemble points at the new code', true, () => setDoc(doc(alice, 'ensembles', 'nnb'), { codeId: C_NNB2 }, { merge: true }));
// the leaders' code opens the ensemble too, and makes a device a leader
const dave = env.authenticatedContext('dave').firestore();
await check('join with the leaders\' code', true, () => setDoc(doc(dave, 'members', 'dave', 'ensembles', 'nnb'), { code: L_NNB }));
await check('lead with the leaders\' code', true, () => setDoc(doc(dave, 'leaders', 'dave', 'ensembles', 'nnb'), { code: L_NNB }));
await check('dave renames', true, () => setDoc(doc(dave, 'ensembles', 'nnb'), { name: 'Dave' }, { merge: true }));
// a new leaders' code
await check('new leaders\' code', true, () => setDoc(doc(alice, 'leaderCodes', L_NNB2), { ensemble: 'nnb' }));
await check('point at it', true, () => setDoc(doc(alice, 'ensembles', 'nnb'), { leaderCodeId: L_NNB2 }, { merge: true }));
await check('retire the old leaders\' code', true, () => deleteDoc(doc(alice, 'leaderCodes', L_NNB)));
await check('old leaders\' code no longer leads', false, () => setDoc(doc(carol, 'leaders', 'carol', 'ensembles', 'nnb'), { code: L_NNB }));
await check('a member cannot retire a leaders\' code', false, () => deleteDoc(doc(bob, 'leaderCodes', L_NNB2)));
console.log(`\n${pass} passed, ${fail} failed`);
await env.cleanup();
process.exit(fail ? 1 : 0);
