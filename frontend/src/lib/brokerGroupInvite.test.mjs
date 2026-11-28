import assert from "node:assert/strict";
import { cleanGroupInviteUrl, DEFAULT_BROKER_GROUP_INVITE_URL } from "./brokerGroupInvite.ts";

assert.equal(cleanGroupInviteUrl(""), null);
assert.equal(cleanGroupInviteUrl(undefined), null);
assert.equal(cleanGroupInviteUrl("not a url"), null);
assert.equal(cleanGroupInviteUrl("http://chat.whatsapp.com/IDQbF12NdrCEq0VOqQpS1l"), null);
assert.equal(cleanGroupInviteUrl("https://evil.example/chat.whatsapp.com/IDQbF12NdrCEq0VOqQpS1l"), null);
assert.equal(cleanGroupInviteUrl("https://chat.whatsapp.com.evil.example/IDQbF12NdrCEq0VOqQpS1l"), null);
assert.equal(cleanGroupInviteUrl("https://chat.whatsapp.com/short"), null);
assert.equal(cleanGroupInviteUrl("https://wa.me/919999999999"), null);
assert.equal(
  cleanGroupInviteUrl("https://chat.whatsapp.com/IDQbF12NdrCEq0VOqQpS1l?s=cl&p=a&iam=2"),
  "https://chat.whatsapp.com/IDQbF12NdrCEq0VOqQpS1l",
);
assert.equal(cleanGroupInviteUrl(DEFAULT_BROKER_GROUP_INVITE_URL), DEFAULT_BROKER_GROUP_INVITE_URL);
console.log("brokerGroupInvite tests passed");
