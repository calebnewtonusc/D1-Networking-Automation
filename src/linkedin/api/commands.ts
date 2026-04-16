import type { LinkedInClient } from "./client.js";
import { generateTrackingId } from "./client.js";
import { readFileSync, accessSync, constants } from "node:fs";

// ── Profile ─────────────────────────────────────────────────────────────────

export async function profileView(client: LinkedInClient, publicId: string) {
  return client.get(
    `/identity/profiles/${encodeURIComponent(publicId)}/profileView`,
  );
}

export async function profileMe(client: LinkedInClient) {
  return client.get("/me");
}

export async function profileContactInfo(
  client: LinkedInClient,
  publicId: string,
) {
  return client.get(
    `/identity/profiles/${encodeURIComponent(publicId)}/profileContactInfo`,
  );
}

export async function profileSkills(
  client: LinkedInClient,
  publicId: string,
  limit = 100,
) {
  return client.get(
    `/identity/profiles/${encodeURIComponent(publicId)}/skills`,
    { count: limit, start: 0 },
  );
}

export async function profileNetwork(client: LinkedInClient, publicId: string) {
  return client.get(
    `/identity/profiles/${encodeURIComponent(publicId)}/networkinfo`,
  );
}

export async function profileBadges(client: LinkedInClient, publicId: string) {
  return client.get(
    `/identity/profiles/${encodeURIComponent(publicId)}/memberBadges`,
  );
}

export async function profilePrivacy(client: LinkedInClient, publicId: string) {
  return client.get(
    `/identity/profiles/${encodeURIComponent(publicId)}/privacySettings`,
  );
}

export async function profilePosts(
  client: LinkedInClient,
  urnId: string,
  limit = 10,
  start = 0,
) {
  return client.get("/identity/profileUpdatesV2", {
    count: limit,
    start,
    q: "memberShareFeed",
    moduleKey: "member-shares:phone",
    includeLongTermHistory: true,
    profileUrn: `urn:li:fsd_profile:${urnId}`,
  });
}

export async function profileDisconnect(
  client: LinkedInClient,
  publicId: string,
) {
  return client.post(
    `/identity/profiles/${encodeURIComponent(publicId)}/profileActions?action=disconnect`,
  );
}

// ── Connections ──────────────────────────────────────────────────────────────

export async function connectionsSend(
  client: LinkedInClient,
  profileUrn: string,
  message?: string,
) {
  const payload: Record<string, unknown> = {
    invitee: {
      inviteeUnion: {
        memberProfile: `urn:li:fsd_profile:${profileUrn}`,
      },
    },
  };
  if (message) payload.customMessage = message;

  return client.post(
    "/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2",
    payload,
  );
}

export async function connectionsReceived(
  client: LinkedInClient,
  limit = 100,
  start = 0,
) {
  return client.get("/relationships/invitationViews", {
    start,
    count: limit,
    includeInsights: true,
    q: "receivedInvitation",
  });
}

export async function connectionsSent(
  client: LinkedInClient,
  limit = 100,
  start = 0,
) {
  return client.get("/relationships/sentInvitationViewsV2", {
    start,
    count: limit,
    invitationType: "CONNECTION",
    q: "invitationType",
  });
}

export async function connectionsAccept(
  client: LinkedInClient,
  invitationId: string,
  secret: string,
) {
  return client.post(
    `/relationships/invitations/${invitationId}?action=accept`,
    {
      invitationId,
      invitationSharedSecret: secret,
      isGenericInvitation: false,
    },
  );
}

export async function connectionsReject(
  client: LinkedInClient,
  invitationId: string,
  secret: string,
) {
  return client.post(
    `/relationships/invitations/${invitationId}?action=ignore`,
    {
      invitationId,
      invitationSharedSecret: secret,
      isGenericInvitation: false,
    },
  );
}

export async function connectionsWithdraw(
  client: LinkedInClient,
  invitationId: string,
) {
  return client.delete(`/relationships/invitations/${invitationId}`);
}

export async function connectionsRemove(
  client: LinkedInClient,
  publicId: string,
) {
  return client.post(
    `/identity/profiles/${encodeURIComponent(publicId)}/profileActions?action=disconnect`,
  );
}

// ── Search ──────────────────────────────────────────────────────────────────

export async function searchPeople(
  client: LinkedInClient,
  opts: {
    keywords?: string;
    network?: "F" | "S" | "O";
    company?: string;
    industry?: string;
    school?: string;
    title?: string;
    firstName?: string;
    lastName?: string;
    geo?: string;
    limit?: number;
    start?: number;
  },
) {
  const filters: string[] = ["(key:resultType,value:List(PEOPLE))"];
  if (opts.network) filters.push(`(key:network,value:List(${opts.network}))`);
  if (opts.company)
    filters.push(`(key:currentCompany,value:List(${opts.company}))`);
  if (opts.industry)
    filters.push(`(key:industry,value:List(${opts.industry}))`);
  if (opts.school) filters.push(`(key:schools,value:List(${opts.school}))`);
  if (opts.title)
    filters.push(`(key:title,value:List(${encodeURIComponent(opts.title)}))`);
  if (opts.firstName)
    filters.push(
      `(key:firstName,value:List(${encodeURIComponent(opts.firstName)}))`,
    );
  if (opts.lastName)
    filters.push(
      `(key:lastName,value:List(${encodeURIComponent(opts.lastName)}))`,
    );
  if (opts.geo) filters.push(`(key:geoUrn,value:List(${opts.geo}))`);

  const queryParams = `List(${filters.join(",")})`;
  const keywords = opts.keywords ? encodeURIComponent(opts.keywords) : "";
  const start = opts.start ?? 0;

  const variables = `(start:${start},origin:GLOBAL_SEARCH_HEADER,query:(keywords:${keywords},flagshipSearchIntent:SEARCH_SRP,queryParameters:${queryParams},includeFiltersInResponse:false))`;

  return client.get("/graphql", {
    variables,
    queryId: "voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0",
  });
}

export async function searchCompanies(
  client: LinkedInClient,
  keywords: string,
  limit = 10,
  start = 0,
) {
  const kw = encodeURIComponent(keywords);
  const variables = `(start:${start},origin:GLOBAL_SEARCH_HEADER,query:(keywords:${kw},flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:resultType,value:List(COMPANIES))),includeFiltersInResponse:false))`;

  return client.get("/graphql", {
    variables,
    queryId: "voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0",
  });
}

export async function searchJobs(
  client: LinkedInClient,
  opts: {
    keywords: string;
    location?: string;
    experience?: string;
    jobType?: string;
    remote?: boolean;
    postedWithin?: string;
    limit?: number;
    start?: number;
  },
) {
  const selectedFilters: string[] = [];
  if (opts.experience)
    selectedFilters.push(`experience:List(${opts.experience})`);
  if (opts.jobType) selectedFilters.push(`jobType:List(${opts.jobType})`);
  if (opts.remote) selectedFilters.push("workplaceType:List(2)");
  if (opts.postedWithin)
    selectedFilters.push(`timePostedRange:List(${opts.postedWithin})`);
  if (opts.location) selectedFilters.push(`distance:List(25)`);

  const filtersStr =
    selectedFilters.length > 0
      ? `,selectedFilters:(${selectedFilters.join(",")})`
      : "";
  const locationStr = opts.location
    ? `,locationFallback:${encodeURIComponent(opts.location)}`
    : "";

  return client.get("/voyagerJobsDashJobCards", {
    decorationId:
      "com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-174",
    count: opts.limit ?? 25,
    q: "jobSearch",
    query: `(origin:JOB_SEARCH_PAGE_QUERY_EXPANSION,keywords:${encodeURIComponent(opts.keywords)}${locationStr}${filtersStr},spellCorrectionEnabled:true)`,
    start: opts.start ?? 0,
  });
}

export async function searchPosts(
  client: LinkedInClient,
  keywords: string,
  limit = 10,
  start = 0,
) {
  const kw = encodeURIComponent(keywords);
  const variables = `(start:${start},origin:GLOBAL_SEARCH_HEADER,query:(keywords:${kw},flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:resultType,value:List(CONTENT))),includeFiltersInResponse:false))`;

  return client.get("/graphql", {
    variables,
    queryId: "voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0",
  });
}

// ── Messaging ───────────────────────────────────────────────────────────────

export async function messagingConversations(client: LinkedInClient) {
  return client.get("/messaging/conversations", {
    keyVersion: "LEGACY_INBOX",
  });
}

export async function messagingConversationWith(
  client: LinkedInClient,
  profileUrn: string,
) {
  return client.get("/messaging/conversations", {
    keyVersion: "LEGACY_INBOX",
    q: "participants",
    recipients: `List(${profileUrn})`,
  });
}

export async function messagingMessages(
  client: LinkedInClient,
  conversationId: string,
  before?: number,
) {
  const query: Record<string, unknown> = { keyVersion: "LEGACY_INBOX" };
  if (before) query.createdBefore = before;
  return client.get(`/messaging/conversations/${conversationId}/events`, query);
}

export async function messagingSend(
  client: LinkedInClient,
  conversationId: string,
  text: string,
) {
  return client.post(
    `/messaging/conversations/${conversationId}/events?action=create`,
    {
      eventCreate: {
        originToken: crypto.randomUUID(),
        value: {
          "com.linkedin.voyager.messaging.create.MessageCreate": {
            attributedBody: { text, attributes: [] },
            attachments: [],
          },
        },
        trackingId: generateTrackingId(),
      },
      dedupeByClientGeneratedToken: false,
    },
  );
}

export async function messagingSendNew(
  client: LinkedInClient,
  recipientUrns: string[],
  text: string,
) {
  return client.post("/messaging/conversations?action=create", {
    keyVersion: "LEGACY_INBOX",
    conversationCreate: {
      eventCreate: {
        originToken: crypto.randomUUID(),
        value: {
          "com.linkedin.voyager.messaging.create.MessageCreate": {
            attributedBody: { text, attributes: [] },
            attachments: [],
          },
        },
        trackingId: generateTrackingId(),
      },
      recipients: recipientUrns,
      subtype: "MEMBER_TO_MEMBER",
    },
  });
}

export async function messagingMarkRead(
  client: LinkedInClient,
  conversationId: string,
) {
  return client.post(`/messaging/conversations/${conversationId}`, {
    patch: { $set: { read: true } },
  });
}

// ── Posts ────────────────────────────────────────────────────────────────────

function getMimeType(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop();
  const types: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return types[ext ?? ""] ?? "image/jpeg";
}

async function uploadImage(
  client: LinkedInClient,
  filePath: string,
): Promise<string> {
  accessSync(filePath, constants.R_OK);
  const fileBuffer = readFileSync(filePath);
  const fileSize = fileBuffer.byteLength;
  const filename = filePath.split("/").pop() ?? "image.jpg";

  const uploadMeta = await client.post<Record<string, unknown>>(
    "/voyagerVideoDashMediaUploadMetadata?action=upload",
    { mediaUploadType: "IMAGE_SHARING", fileSize, filename },
  );

  const data = uploadMeta?.data as Record<string, unknown> | undefined;
  const value = data?.value as Record<string, unknown> | undefined;
  const uploadUrl = value?.singleUploadUrl as string | undefined;
  const mediaUrn = value?.urn as string | undefined;

  if (!uploadUrl || !mediaUrn) {
    throw new Error("Failed to get image upload URL from LinkedIn");
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "content-type": getMimeType(filename),
      "media-type-family": "STILLIMAGE",
    },
    body: fileBuffer,
  });

  if (!uploadResponse.ok) {
    throw new Error(`Image upload failed: ${uploadResponse.status}`);
  }

  return mediaUrn;
}

export async function postsCreate(
  client: LinkedInClient,
  text: string,
  opts?: {
    visibility?: "anyone" | "connections";
    imagePath?: string;
    commentsScope?: "all" | "connections" | "none";
  },
) {
  const scopeMap: Record<string, string> = {
    all: "ALL",
    connections: "CONNECTIONS_ONLY",
    none: "NONE",
  };

  const mediaItems: unknown[] = [];
  if (opts?.imagePath) {
    const mediaUrn = await uploadImage(client, opts.imagePath);
    mediaItems.push({ category: "IMAGE", mediaUrn, tapTargets: [] });
  }

  return client.post("/contentcreation/normShares", {
    visibleToConnectionsOnly: opts?.visibility === "connections",
    externalAudienceProviders: [],
    commentaryV2: { text, attributes: [] },
    origin: "FEED",
    allowedCommentersScope: scopeMap[opts?.commentsScope ?? "all"] ?? "ALL",
    postState: "PUBLISHED",
    media: mediaItems,
  });
}

export async function postsEdit(
  client: LinkedInClient,
  shareUrn: string,
  text: string,
) {
  const urnEncoded = encodeURIComponent(shareUrn);
  return client.post(`/contentcreation/normShares/${urnEncoded}`, {
    patch: {
      $set: {
        commentaryV2: {
          text,
          attributes: [],
          $type: "com.linkedin.voyager.common.TextViewModel",
        },
      },
    },
  });
}

export async function postsDelete(client: LinkedInClient, shareUrn: string) {
  return client.delete(
    `/contentcreation/normShares/${encodeURIComponent(shareUrn)}`,
  );
}

// ── Feed ────────────────────────────────────────────────────────────────────

export async function feedView(client: LinkedInClient, limit = 10, start = 0) {
  return client.get("/feed/updatesV2", {
    count: limit,
    start,
    q: "chronFeed",
  });
}

export async function feedUser(
  client: LinkedInClient,
  profileId: string,
  limit = 10,
  start = 0,
) {
  return client.get("/feed/updates", {
    profileId,
    q: "memberShareFeed",
    moduleKey: "member-share",
    count: limit,
    start,
  });
}

export async function feedCompany(
  client: LinkedInClient,
  companyName: string,
  limit = 10,
  start = 0,
) {
  return client.get("/feed/updates", {
    companyUniversalName: companyName,
    q: "companyFeedByUniversalName",
    moduleKey: "member-share",
    count: limit,
    start,
  });
}

// ── Engage ──────────────────────────────────────────────────────────────────

export type ReactionType =
  | "LIKE"
  | "PRAISE"
  | "APPRECIATION"
  | "EMPATHY"
  | "INTEREST"
  | "ENTERTAINMENT";

export async function engageReact(
  client: LinkedInClient,
  postUrn: string,
  type: ReactionType = "LIKE",
) {
  return client.post(
    `/voyagerSocialDashReactions?threadUrn=urn:li:activity:${postUrn}`,
    { reactionType: type },
  );
}

export async function engageReactions(
  client: LinkedInClient,
  postUrn: string,
  limit = 10,
  start = 0,
) {
  return client.get("/feed/reactions", {
    count: limit,
    q: "reactionType",
    sortOrder: "REV_CHRON",
    start,
    threadUrn: `urn:li:activity:${postUrn}`,
  });
}

export async function engageComment(
  client: LinkedInClient,
  postUrn: string,
  text: string,
) {
  return client.post(`/feed/comments?threadUrn=urn:li:activity:${postUrn}`, {
    threadUrn: `urn:li:activity:${postUrn}`,
    commentaryV2: { text, attributes: [] },
    trackingId: generateTrackingId(),
  });
}

export async function engageComments(
  client: LinkedInClient,
  postUrn: string,
  limit = 10,
  start = 0,
) {
  return client.get("/feed/comments", {
    count: limit,
    q: "comments",
    sortOrder: "RELEVANCE",
    start,
    threadUrn: `urn:li:activity:${postUrn}`,
    updateUrn: `urn:li:activity:${postUrn}`,
  });
}

// ── Companies ───────────────────────────────────────────────────────────────

export async function companyView(
  client: LinkedInClient,
  universalName: string,
) {
  return client.get(
    `/organization/companies?decorationId=com.linkedin.voyager.dash.deco.organization.MiniCompany-2&q=universalName&universalName=${encodeURIComponent(universalName)}`,
  );
}

export async function companyPeople(
  client: LinkedInClient,
  companyId: string,
  limit = 10,
  start = 0,
) {
  const filters = `List((key:resultType,value:List(PEOPLE)),(key:currentCompany,value:List(${companyId})))`;
  const variables = `(start:${start},origin:FACETED_SEARCH,query:(flagshipSearchIntent:ORGANIZATIONS_PEOPLE_ALUMNI,queryParameters:${filters},includeFiltersInResponse:false))`;

  return client.get("/graphql", {
    variables,
    queryId: "voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0",
  });
}

export async function companyJobs(
  client: LinkedInClient,
  companyId: string,
  limit = 25,
  start = 0,
) {
  return client.get("/voyagerJobsDashJobCards", {
    decorationId:
      "com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-174",
    count: limit,
    q: "jobSearch",
    query: `(origin:JOB_SEARCH_PAGE_OTHER_ENTRY,selectedFilters:(company:List(${companyId})),spellCorrectionEnabled:true)`,
    start,
  });
}

// ── Analytics ───────────────────────────────────────────────────────────────

export async function analyticsProfileViews(client: LinkedInClient) {
  return client.get(
    "/identity/wvmpCards?q=cardType&cardTypes=List(PROFILE_VIEWER,PROFILE_VIEWER_STATISTICS)&count=20",
  );
}

export async function analyticsSearchAppearances(client: LinkedInClient) {
  return client.get("/identity/wvmpCards", {
    q: "cardType",
    cardTypes: "List(SEARCH_APPEARANCE)",
    count: 20,
  });
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export async function jobView(client: LinkedInClient, jobId: string) {
  return client.get(
    `/jobs/jobPostings/${jobId}?decorationId=com.linkedin.voyager.dash.deco.jobs.JobPosting-78`,
  );
}

export async function jobSave(client: LinkedInClient, jobId: string) {
  return client.post("/voyagerJobsDashMyJobApplications", {
    jobPosting: `urn:li:fsd_jobPosting:${jobId}`,
    savedAction: "SAVE",
  });
}

export async function jobUnsave(client: LinkedInClient, jobId: string) {
  return client.post("/voyagerJobsDashMyJobApplications", {
    jobPosting: `urn:li:fsd_jobPosting:${jobId}`,
    savedAction: "UNSAVE",
  });
}
