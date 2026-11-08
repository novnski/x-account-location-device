/** Issue #84: public chat identities and routes; no network or private DM fixtures. */
import assert from 'node:assert/strict';
import {
    CHAT_LIMITS, isChatUsersUrl, projectChatIdentities, chatPeerId, profileHandleFromUrl
} from '../src/shared/chat-data.js';
import { inboxHandle } from '../src/content/chat-badges.js';

let passed = 0;
function check(name, run) {
    run();
    passed++;
    console.log(`PASS ${name}`);
}
const endpoint = queryId => `https://api.x.com/graphql/${queryId}/GetUsersByIdsForXChat`;
const member = (id = '128484298', handle = 'Dinosn') => ({
    __typename: 'XChatMemberResult', id, status: 'Found',
    member_results: {
        __typename: 'UserResults', rest_id: id,
        result: {
            __typename: 'User', rest_id: id,
            core: { screen_name: handle, name: 'Public example name' },
            chat_permissions: { can_dm: true },
            relationship_counts: { followers: 42 }
        }
    }
});
const envelope = rows => ({ data: { get_member_results: { results: rows } } });

check('The native public-user endpoint accepts changing query IDs and variables', () => {
    assert.equal(isChatUsersUrl(endpoint('Z5JAtnND9clU-zWgoUTvLg') + '?variables=%7B%22ids%22%3A%5B%22128484298%22%5D%7D'), true);
    assert.equal(isChatUsersUrl(endpoint('another_Query-123')), true);
});

check('Unrelated chat operations, spoofed origins and malformed URLs are excluded', () => {
    for (const value of [
        null, {}, '', '/graphql/query/GetUsersByIdsForXChat',
        endpoint('id').replace('api.x.com', 'api.x.com.evil.test'),
        endpoint('id').replace('https:', 'http:'),
        endpoint('id').replace('api.x.com', 'attacker@api.x.com'),
        endpoint('id').replace('api.x.com', 'api.x.com:8080'),
        endpoint('id').replace('GetUsersByIdsForXChat', 'GetMessagesForXChat'),
        endpoint('id') + '/more', endpoint('id') + '/', endpoint('id') + '\n',
        endpoint('id').replace('/graphql/', '/graphql\\'),
        endpoint('a'.repeat(101))
    ]) assert.equal(isChatUsersUrl(value), false, String(value));
});

check('Profile paths give exact normalized handles', () => {
    assert.equal(profileHandleFromUrl('/Dinosn'), 'dinosn');
    assert.equal(profileHandleFromUrl('https://x.com/Dinosn'), 'dinosn');
    assert.equal(profileHandleFromUrl('/Dinosn/?ref=chat#name'), 'dinosn');
    assert.equal(profileHandleFromUrl('/a_123'), 'a_123');
});

check('App routes, external links and ambiguous paths cannot identify accounts', () => {
    for (const value of [
        null, {}, 'Dinosn', '/home', '/I', '/messages', '/settings', '/login',
        '/i/chat/123-456', '/Dinosn/status/123', '/Dinosn/more', '/@Dinosn',
        '/long_handle_over_15', '/Dinosn\n', '//x.com/Dinosn',
        'http://x.com/Dinosn', 'https://x.com.evil.test/Dinosn',
        'https://attacker@x.com/Dinosn', 'https://x.com\\evil.test/Dinosn',
        'https://x.com/%44inosn', 'https://api.x.com/Dinosn'
    ]) assert.equal(profileHandleFromUrl(value), null, String(value));
});

check('Conversation peer selection works in either participant order and request routes', () => {
    assert.equal(chatPeerId('/i/chat/127580312-128484298', '127580312'), '128484298');
    assert.equal(chatPeerId('/i/chat/128484298-127580312', '127580312'), '128484298');
    assert.equal(chatPeerId('/i/chat/requests/127580312-359163730', '127580312'), '359163730');
    assert.equal(chatPeerId('https://x.com/i/chat/127580312-128484298/', '127580312'), '128484298');
});

check('Snowflake IDs retain all digits without numeric coercion', () => {
    const id = '1840842106572578816';
    assert.equal(chatPeerId(`/i/chat/127580312-${id}`, '127580312'), id);
    assert.deepEqual(projectChatIdentities(envelope([member(id, 'large_id')])), [{ u: 'large_id', i: id }]);
    assert.equal(chatPeerId('/i/chat/127580312-128484298', 127580312), null);
    assert.deepEqual(projectChatIdentities(envelope([member(128484298)])), []);
});

check('Unknown viewers, group routes and invalid participant pairs remain unknown', () => {
    for (const value of [
        '/i/chat/128484298', '/i/chat/127580312-128484298-359163730',
        '/i/chat/127580312-127580312', '/i/chat/0127580312-128484298',
        '/i/chat/127580312-0', '/i/chat/127580312-128484298/more',
        '/i/chat/127580312-128484298\n', '/messages/127580312-128484298',
        'https://evil.test/i/chat/127580312-128484298'
    ]) assert.equal(chatPeerId(value, '127580312'), null, value);
    assert.equal(chatPeerId('/i/chat/127580312-128484298', '359163730'), null);
    assert.equal(chatPeerId('/i/chat/127580312-128484298', 'id:127580312'), null);
    assert.equal(chatPeerId('/i/chat/127580312-128484298', null), null);
});

check('Only public identity primitives leave the response projector', () => {
    const source = envelope([member()]);
    source.data.get_member_results.results[0].message = 'PRIVATE_MESSAGE_NOT_TO_RELAY';
    const result = projectChatIdentities(source);
    assert.deepEqual(result, [{ u: 'dinosn', i: '128484298' }]);
    assert.equal(JSON.stringify(result).includes('PRIVATE_MESSAGE_NOT_TO_RELAY'), false);
    assert.equal(JSON.stringify(result).includes('can_dm'), false);
    assert.equal(source.data.get_member_results.results[0].member_results.result.core.screen_name, 'Dinosn');
});

check('Missing, malformed and non-Found users provide no identity evidence', () => {
    const invalid = [];
    for (const status of ['Missing', 'Unavailable', 'Suspended', null, undefined]) invalid.push({ ...member(), status });
    invalid.push(null, {}, { ...member(), member_results: null });
    const wrongType = member();
    wrongType.member_results.result.__typename = 'UserUnavailable';
    invalid.push(wrongType);
    for (const handle of ['', '@Dinosn', 'name with space', 'Dinosn\n', 'x'.repeat(16), null, 42]) invalid.push(member('128484298', handle));
    for (const id of ['', '0', '0123', '-3', '123\n', '1'.repeat(21), null]) invalid.push(member(id));
    assert.deepEqual(projectChatIdentities(envelope(invalid)), []);
    for (const source of [null, {}, [], { data: null }, envelope(null), envelope({})]) {
        assert.deepEqual(projectChatIdentities(source), []);
    }
});

check('Every supplied wrapper and user ID must agree exactly', () => {
    const mismatchedWrapper = member();
    mismatchedWrapper.member_results.rest_id = '220261476';
    const mismatchedUser = member();
    mismatchedUser.member_results.result.rest_id = '220261476';
    const numericUser = member();
    numericUser.member_results.result.rest_id = 128484298;
    const missingWrapper = member();
    delete missingWrapper.member_results.rest_id;
    assert.deepEqual(projectChatIdentities(envelope([mismatchedWrapper, mismatchedUser, numericUser, missingWrapper])), []);
});

check('Exact duplicates are deduplicated and conflicting identities are withheld', () => {
    assert.deepEqual(projectChatIdentities(envelope([member(), member('128484298', 'DINOSN')])), [{ u: 'dinosn', i: '128484298' }]);
    assert.deepEqual(projectChatIdentities(envelope([member(), member('128484298', 'different')])), []);
    assert.deepEqual(projectChatIdentities(envelope([member(), member('220261476', 'DINOSN')])), []);
    const result = projectChatIdentities(envelope([
        member(), member('128484298', 'different'), member('220261476', 'different'), member('333', 'safe')
    ]));
    assert.deepEqual(result, [{ u: 'safe', i: '333' }]);
});

check('Response iteration and output stay bounded even for oversized payloads', () => {
    const rows = Array.from({ length: CHAT_LIMITS.MAX_USERS_PER_RESPONSE }, (_, index) => member(String(index + 1), `person_${index}`));
    Object.defineProperty(rows, CHAT_LIMITS.MAX_USERS_PER_RESPONSE, {
        get() { throw new Error('Must not inspect beyond the response cap'); }
    });
    const result = projectChatIdentities(envelope(rows));
    assert.equal(result.length, CHAT_LIMITS.MAX_USERS_PER_RESPONSE);
    assert.deepEqual(result[0], { u: 'person_0', i: '1' });
    assert.deepEqual(result.at(-1), { u: 'person_499', i: '500' });
});

check('Inbox authors come from the exact accessibility prefix, never a preview mention', () => {
    assert.equal(inboxHandle('Alice, @Alice, Hello @bob, 2d', 'Alice'), 'alice');
    assert.equal(inboxHandle('Alice, Example @bob, 2d', 'Alice'), null);
    assert.equal(inboxHandle('Another Alice, @bob, Hello, 2d', 'Alice'), null);
    assert.equal(inboxHandle('Alice, @alice_name_too_long, Hello, 2d', 'Alice'), null);
    assert.equal(inboxHandle(null, 'Alice'), null);
    assert.equal(inboxHandle('Alice, @alice, Hello, 2d', ''), null);
});

console.log(`${passed} chat identity checks passed. No network requests made.`);
