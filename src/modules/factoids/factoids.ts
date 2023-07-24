/**
 * @file
 * This file contains the `factoid` module definition.
 */
import {Db} from 'mongodb';
import type {Collection, DeleteResult} from 'mongodb';
import {request} from 'undici';

import * as util from '../../core/util.js';
import {Attachment, BaseMessageOptions, Events, Message} from 'discord.js';
import {validateMessage} from './factoid_validation.js';

interface Factoid {
  /** The primary term used to refer to the factoid */
  name: string;
  /** Any alternative terms used to refer to the factoid */
  aliases: string[];
  /** Whether or not the factoid will show up in lists */
  hidden: boolean;
  /** The message you'd like to be sent when the factoid is triggered. While preferably an embed, this could be any valid form of message */
  message: BaseMessageOptions;
}
/** The name of the MongoDB collection where factoids should be stored */
const FACTOID_COLLECTION_NAME = 'factoids';
const factoid = new util.RootModule(
  'factoid',
  'Manage or fetch user generated messages',
  [util.mongo]
);
// TODO: implement an LRU factoid cache

factoid.onInitialize(async () => {
  // these are defined outside so that they don't get redefined every time a
  // message is sent
  const db: Db = util.mongo.fetchValue();
  const factoids: Collection<Factoid> = db.collection<Factoid>(
    FACTOID_COLLECTION_NAME
  );
  const prefixes: string[] = factoid.config.prefixes;
  // listen for a message sent by any of a few prefixes
  // only register a listener if at least one prefix was specified
  if (prefixes.length === 0) {
    return;
  }

  util.client.on(Events.MessageCreate, async (message: Message<boolean>) => {
    // anything that does not include
    if (!prefixes.includes(message.content.charAt(0))) {
      return;
    }
    // make sure factoids can only be triggered by non bot users
    if (message.author.bot) {
      return;
    }
    //remove the prefix, split by spaces, and query the DB
    const queryArguments: string[] = message.content.slice(1).split(' ');
    const queryResult = await factoids.findOne({
      name: queryArguments[0],
    });
    // no match found
    if (queryResult === null) {
      return;
    }
    // match found, send factoid
    await message.reply(queryResult.message).catch(err => {
      util.logEvent(
        util.EventCategory.Error,
        'factoid',
        `An error was encountered sending factoid: ${(err as Error).name}`,
        3
      );
    });
  });
});

// TODO: use deferreply for all of these, on the off chance a reply takes over 3 secs
factoid.registerSubModule(
  new util.SubModule(
    'get',
    'Fetch a factoid from the database and return it',
    [
      {
        type: util.ModuleOptionType.String,
        name: 'factoid',
        description: 'The factoid to fetch',
        required: true,
      },
    ],
    async (args, interaction) => {
      const factoidName: string =
        args.find(arg => arg.name === 'factoid')!.value!.toString() ?? '';
      const db: Db = util.mongo.fetchValue();
      const factoids: Collection<Factoid> = db.collection<Factoid>(
        FACTOID_COLLECTION_NAME
      );
      // findOne returns null if it doesn't find the thing
      const locatedFactoid: Factoid | null = await factoids.findOne({
        name: factoidName,
      });
      if (locatedFactoid === null) {
        return util.embed.errorEmbed(
          'Unable to located the factoid specified.'
        );
      }

      await util
        .replyToInteraction(interaction, locatedFactoid.message)
        .catch(err => {
          util.logEvent(
            util.EventCategory.Error,
            'factoid',
            `An error was encountered sending factoid: ${(err as Error).name}`,
            3
          );
        });
    }
  )
);

factoid.registerSubModule(
  new util.SubModule(
    'remember',
    'Register a new factoid',
    [
      {
        type: util.ModuleOptionType.String,
        name: 'name',
        description: 'The name of the factoid',
        required: true,
      },
      {
        type: util.ModuleOptionType.Attachment,
        name: 'factoid',
        description: 'A .json describing a valid factoid',
        required: true,
      },
    ],
    async (args, interaction) => {
      const db: Db = util.mongo.fetchValue();
      const factoids = db.collection<Factoid>(FACTOID_COLLECTION_NAME);
      // first see if they uploaded a factoid
      // the json upload
      const uploadedFactoid: Attachment = args.find(
        arg => arg.name === 'factoid'
      )!.attachment!;

      // fetch the first attachment, ignore the rest
      // non-null assertion: we've verified that there's at least one attachment

      const {body} = await request(uploadedFactoid.url);
      // the factoid as a string
      const serializedFactoid = await body.text();
      // then validate it
      let messageIssues: string[] = [];
      try {
        for (const issues of validateMessage(serializedFactoid)) {
          messageIssues = issues;
        }
      } catch (err) {
        messageIssues.push(
          `Factoid validation failed with error: ${(err as Error).name}`
        );
      }
      // if any errors were found with the factoid to remember, return early
      if (messageIssues.length > 0) {
        return util.embed.errorEmbed(
          `The following issues were found with the attached json (remember cancelled):\n - ${messageIssues.join(
            '\n- '
          )}`
        );
      }
      // if no name was specified, return early
      if (args === undefined) {
        return util.embed.errorEmbed(
          'Factoid name missing from command invocation, please specify a name.'
        );
      }

      const factoid_name: string =
        args.filter(arg => arg.name === 'name')[0].value?.toString() ??
        'somethingBrokeThisShouldBeImpossible';

      // Makes sure the factoid doesn't exist already
      const locatedFactoid: Factoid | null = await factoids.findOne({
        name: factoid_name,
      });

      // The factoid already exists
      if (locatedFactoid !== null) {
        // Deletion confirmation
        const response = await util.embed.confirmEmbed(
          `The factoid \`${factoid_name}\` already exists! Overwrite it?`,
          interaction
        );

        if (response === util.ConfirmEmbedResponse.Denied) {
          return util.embed.errorEmbed(
            `The factoid \`${factoid_name}\` was not overwritten`
          );
        }

        if (response === util.ConfirmEmbedResponse.Confirmed) {
          // Delete the factoid
          const result: DeleteResult = await factoids.deleteOne({
            name: factoid_name,
          });

          // If nothing got deleted, something done broke
          if (result.deletedCount === 0) {
            return util.embed.errorEmbed(
              `Deletion failed, unable to find the factoid \`${name}\``
            );
          }
        }
      }

      // the structure sent to the database
      const factoid: Factoid = {
        // the option is *required* so this option should always exist,
        // but you're not supposed use non-null assertion after filter calls
        name: factoid_name,
        aliases: [],
        hidden: false,
        message: JSON.parse(serializedFactoid),
      };
      // strip all mentions from the factoid
      // https://discord.com/developers/docs/resources/channel#allowed-mentions-object
      factoid.message.allowedMentions = {
        parse: [],
      };
      // TODO: allow plain text factoids by taking everything after the argument

      await factoids.insertOne(factoid).catch(err => {
        return util.embed.errorEmbed(
          `Database call failed with error ${(err as Error).name}`
        );
      });

      return util.embed.successEmbed(
        'Factoid successfully registered: ' + factoid.name
      );
    }
  )
);

factoid.registerSubModule(
  new util.SubModule(
    'forget',
    'Remove a factoid',
    [
      {
        type: util.ModuleOptionType.String,
        name: 'factoid',
        description: 'The factoid to forget',
        required: true,
      },
    ],
    async args => {
      const factoidName = args.find(arg => arg.name === 'factoid')!
        .value as string;
      const db: Db = util.mongo.fetchValue();
      const factoids: Collection<Factoid> = db.collection(
        FACTOID_COLLECTION_NAME
      );
      const result: DeleteResult = await factoids.deleteOne({
        name: factoidName,
      });

      if (result.deletedCount === 0) {
        return util.embed.errorEmbed(
          `Deletion failed, unable to find factoid \`${factoidName}\``
        );
      } else {
        // if stuff was deleted, than we probably found the factoid, return success
        return util.embed.successEmbed(
          `Factoid successfully deleted: \`${factoidName}\``
        );
      }
    }
  )
);

factoid.registerSubModule(
  new util.SubModule(
    'json',
    'Fetch a factoids json config from the database and return it',
    [
      {
        type: util.ModuleOptionType.String,
        name: 'factoid',
        description: 'The factoid to fetch the json of',
        required: true,
      },
    ],
    async (args, interaction) => {
      const factoidName: string =
        (args.filter(arg => arg.name === 'factoid')[0].value as string) ?? '';
      const db: Db = util.mongo.fetchValue();
      const factoids: Collection<Factoid> = db.collection<Factoid>(
        FACTOID_COLLECTION_NAME
      );

      // findOne returns null if it doesn't find the thing
      const locatedFactoid: Factoid | null = await factoids.findOne({
        name: factoidName,
      });
      if (locatedFactoid === null) {
        return util.embed.errorEmbed(
          'Unable to located the factoid specified.'
        );
      }

      // Converts the JSON contents to a buffer so it can be sent as an attachment
      const serializedFactoid = JSON.stringify(locatedFactoid);
      const files = Buffer.from(serializedFactoid);

      await util
        .replyToInteraction(interaction, {
          files: [{attachment: files, name: 'factoid.json'}],
        })
        .catch(err => {
          util.logEvent(
            util.EventCategory.Error,
            'factoid',
            `An error was encountered sending factoid: ${(err as Error).name}`,
            3
          );
        });
    }
  )
);

factoid.registerSubModule(
  new util.SubModule('preview', 'Preview a factoid json without remembering it')
);
factoid.registerSubModule(
  new util.SubModule('all', 'Generate a list of all factoids as a webpage')
);

// NOTE: THE BELOW IS TEMPORARY AS A TEST
const ping = new util.SubModule('ping', 'ping the ping');
const pong = new util.SubModule('pong', 'pong the pong', [], async () => {
  console.log('hee hee');
});
factoid.registerSubModule(ping);
ping.registerSubmodule(pong);

export default factoid;
