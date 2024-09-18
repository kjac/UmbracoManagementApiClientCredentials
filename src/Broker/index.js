import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv'
import {Issuer} from 'openid-client';
import {v4 as uuidV4} from 'uuid'

dotenv.config()

const issuer = new Issuer({
    issuer: process.env.UMBRACO_HOST,
    token_endpoint: `${process.env.UMBRACO_HOST}umbraco/management/api/v1/security/back-office/token`
});

const client = new issuer.Client({
    client_id: process.env.UMBRACO_CLIENT_ID,
    client_secret: process.env.UMBRACO_CLIENT_SECRET,
});

let tokenSet = null;

async function getAccessToken() {
    if (!tokenSet || tokenSet.expired()) {
        tokenSet = await client.grant({
            grant_type: 'client_credentials'
        });
        console.info('The token set was updated:', tokenSet);
    }

    return tokenSet.access_token;
}

// the express server port
const expressPort = 3000;

// define the express app and setup required middleware (CORS and JSON)
const app = express();
app.use(cors());
app.use(express.json());

app.post('/member', async (req, res) => {
    const data = req.body;
    if (!data.email || !data.name || !data.memberId) {
        res.status(400).send('Malformed request body (missing required member properties)');
        return;
    }

    await createMember(data.memberId, data.name, data.email, data.isVip ?? false)
        .then(
            () => res.status(200).send(),
            (error) => res.status(error.code).send(error.description)
        );
});

app.put('/member/:memberId', async (req, res) => {
    const data = req.body;
    if (!data.email || !data.name) {
        res.status(400).send('Malformed request body (missing required member properties)');
        return;
    }

    await updateMember(req.params.memberId, data.name, data.email, data.isVip ?? false)
        .then(
            () => res.status(200).send(),
            (error) => res.status(error.code).send(error.description)
        );
});

app.delete('/member/:memberId', async (req, res) => {
    await deleteMember(req.params.memberId)
        .then(
            () => res.status(200).send(),
            (error) => res.status(error.code).send(error.description)
        );
});

// start the express app
app.listen(expressPort, () => console.log(`The service is running on http://localhost:${expressPort}.`));

const createMember = async (memberId, name, email, isVip) => new Promise(async (resolve, reject) => {
    await getMember(memberId).then(
        async (member) => {
            if (member !== null) {
                console.info(`Member with ID '${memberId}' already exists, aborting member creation.`)
                return reject({code: 409, description: 'Member already exists'});
            }

            const umbracoMember = umbracoMemberModel(memberId, name, email, isVip);
            // must set an initial password when creating a member
            umbracoMember.password = uuidV4();

            const accessToken = await getAccessToken();
            const response = await fetch(
                `${process.env.UMBRACO_HOST}umbraco/management/api/v1/member`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(umbracoMember)
                }
            );

            if (response.ok) {
                console.info(`Member with ID '${memberId}' was successfully created.`);
                resolve(true);
            } else {
                const errorDetails = await response.json();
                console.error(`Could not create member with ID '${memberId}':`, errorDetails);
                reject({code: response.status, description: response.statusText});
            }
        },
        (error) => reject(error)
    )
});

const updateMember = async (memberId, name, email, isVip) => new Promise(async (resolve, reject) => {
    await getMember(memberId).then(
        async (member) => {
            if (member === null) {
                console.info(`Member with ID '${memberId}' did not exist, aborting member update.`)
                return reject({code: 404, description: "No such member"});
            }

            const umbracoMember = umbracoMemberModel(memberId, name, email, isVip);

            const accessToken = await getAccessToken();
            const response = await fetch(
                `${process.env.UMBRACO_HOST}umbraco/management/api/v1/member/${member.id}`,
                {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(umbracoMember)
                }
            );

            if (response.ok) {
                console.info(`Member with ID '${memberId}' was successfully updated.`);
                resolve(true);
            } else {
                const errorDetails = await response.json();
                console.error(`Could not update member with ID '${memberId}':`, errorDetails);
                reject({code: response.status, description: response.statusText});
            }
        },
        (error) => reject(error)
    )
});

const deleteMember = async (memberId) => new Promise(async (resolve, reject) => {
    await getMember(memberId).then(
        async (member) => {
            if (member === null) {
                console.info(`Member with ID '${memberId}' did not exist, aborting member deletion.`);
                return reject({code: 404, description: "No such member"});
            }

            const accessToken = await getAccessToken();
            const response = await fetch(
                `${process.env.UMBRACO_HOST}umbraco/management/api/v1/member/${member.id}`,
                {
                    method: 'DELETE',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`
                    }
                }
            );

            if (response.ok) {
                console.info(`Member with ID '${memberId}' was successfully deleted.`);
                resolve(true);
            } else {
                const errorDetails = await response.json();
                console.error(`Could not delete member with ID '${memberId}':`, errorDetails);
                reject({code: response.status, description: response.statusText});
            }
        },
        (error) => reject(error)
    )
});

const getMember = async (memberId) => new Promise(async (resolve, reject) => {
    const accessToken = await getAccessToken();

    const response = await fetch(
        `${process.env.UMBRACO_HOST}umbraco/management/api/v1/filter/member?filter=${memberId}&take=1`,
        {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json'
            }
        }
    );

    if (response.ok) {
        const result = await response.json();
        if (result.total === 0) {
            resolve(null);
            return;
        }

        const item = result.items[0];
        resolve({
            id: item.id,
            email: item.email,
            memberId: item.username,
            name: item.variants[0].name
        });
    } else {
        const errorDetails = response.bodyUsed
            ? await response.json()
            : response.statusText;
        console.error(`Could not get member with ID '${memberId}':`, errorDetails);
        reject({code: response.status, description: response.statusText});
    }
});

const umbracoMemberModel = (memberId, name, email, isVip) => {
    // VIP members should have an extra group membership in Umbraco
    const groupIds = isVip
        ? [process.env.UMBRACO_MEMBER_GROUP_REGULAR_ID, process.env.UMBRACO_MEMBER_GROUP_VIP_ID]
        : [process.env.UMBRACO_MEMBER_GROUP_REGULAR_ID];

    return {
        email: email,
        username: memberId,
        memberType: {
            id: process.env.UMBRACO_MEMBER_TYPE_ID
        },
        isApproved: true,
        groups: groupIds,
        values: [{
            culture: null,
            segment: null,
            alias: "lastSyncMessage",
            value: `Last update: ${(new Date()).toUTCString()}`
        }],
        variants: [
            {
                culture: null,
                segment: null,
                name: name
            }
        ]
    };
}
