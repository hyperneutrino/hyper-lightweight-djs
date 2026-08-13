import {
    ApplicationCommandType,
    AutocompleteInteraction,
    ButtonInteraction,
    ChannelSelectMenuInteraction,
    Client,
    CommandInteraction,
    Events,
    MentionableSelectMenuInteraction,
    MessageComponentInteraction,
    ModalSubmitInteraction,
    RoleSelectMenuInteraction,
    StringSelectMenuInteraction,
    UserSelectMenuInteraction,
    type Awaitable,
    type BaseApplicationCommandData,
    type ChatInputApplicationCommandData,
    type ChatInputCommandInteraction,
    type ClientEvents,
    type MessageApplicationCommandData,
    type MessageContextMenuCommandInteraction,
    type UserApplicationCommandData,
    type UserContextMenuCommandInteraction,
} from "discord.js";
import fs from "node:fs/promises";
import path from "node:path";

// TODO: comments (requires some refactoring of types to do right)

process.on("uncaughtException", (err) => console.error(err));

type Handler<T extends CommandInteraction | AutocompleteInteraction | MessageComponentInteraction | ModalSubmitInteraction> = (
    interaction: T,
    ...args: T extends MessageComponentInteraction | ModalSubmitInteraction ? (string | undefined)[] : []
) => Awaitable<unknown>;

abstract class Command<T extends BaseApplicationCommandData, U extends CommandInteraction, Z extends boolean = false> {
    data: T;
    handler: Handler<U>;
    autocomplete: Handler<AutocompleteInteraction> | null;

    constructor({ handler, ...data }: T & { handler: Handler<U> } & (Z extends true ? { autocomplete?: Handler<AutocompleteInteraction> } : {})) {
        if ("autocomplete" in data) {
            const { autocomplete, ...rest } = data;
            this.autocomplete = autocomplete as Handler<AutocompleteInteraction>;
            this.data = rest as unknown as T;
        } else {
            this.autocomplete = null;
            this.data = data as unknown as T;
        }

        this.handler = handler;
    }
}

export class SlashCommand extends Command<ChatInputApplicationCommandData & { type: ApplicationCommandType.ChatInput }, ChatInputCommandInteraction, true> {}
export class UserCommand extends Command<UserApplicationCommandData, UserContextMenuCommandInteraction> {}
export class MessageCommand extends Command<MessageApplicationCommandData, MessageContextMenuCommandInteraction> {}

abstract class ComponentHandler<T extends ModalSubmitInteraction | MessageComponentInteraction> {
    handler: Handler<T>;

    constructor(handler: Handler<T>) {
        this.handler = handler;
    }
}

export class ModalHandler extends ComponentHandler<ModalSubmitInteraction> {}
export class ButtonHandler extends ComponentHandler<ButtonInteraction> {}
export class StringSelectHandler extends ComponentHandler<StringSelectMenuInteraction> {}
export class UserSelectHandler extends ComponentHandler<UserSelectMenuInteraction> {}
export class RoleSelectHandler extends ComponentHandler<RoleSelectMenuInteraction> {}
export class MentionSelectHandler extends ComponentHandler<MentionableSelectMenuInteraction> {}
export class ChannelSelectHandler extends ComponentHandler<ChannelSelectMenuInteraction> {}

export class EventHandler<T extends keyof ClientEvents> {
    event: T;
    handler: (...args: ClientEvents[T]) => unknown;

    constructor({ event, handler }: { event: T; handler: (...args: ClientEvents[T]) => unknown }) {
        this.event = event;
        this.handler = handler;
    }
}

export async function loadCommands(client: Client<true>, directory: string, guildId?: string) {
    const files = await fs.readdir(path.resolve(directory), { recursive: false, withFileTypes: true });

    const commandData: (ChatInputApplicationCommandData | UserApplicationCommandData | MessageApplicationCommandData)[] = [];

    const slashCommandHandlers = new Map<string, Handler<ChatInputCommandInteraction>>();
    const userCommandHandlers = new Map<string, Handler<UserContextMenuCommandInteraction>>();
    const messageCommandHandlers = new Map<string, Handler<MessageContextMenuCommandInteraction>>();

    const slashCommandAutocompletes = new Map<string, Handler<AutocompleteInteraction>>();

    await Promise.all(
        files.map(async (file) => {
            const absolutePath = path.resolve(file.parentPath, file.name);

            const { default: item } = await import(absolutePath);

            if (item instanceof SlashCommand) {
                slashCommandHandlers.set(item.data.name, item.handler);
                if (item.autocomplete) slashCommandAutocompletes.set(item.data.name, item.autocomplete);
            } else if (item instanceof UserCommand) {
                userCommandHandlers.set(item.data.name, item.handler);
            } else if (item instanceof MessageCommand) {
                messageCommandHandlers.set(item.data.name, item.handler);
            } else {
                throw new Error(
                    `Loading commands failed: export from ${path.relative(path.resolve(directory), absolutePath)} was not an instance of <Type>Command.`,
                );
            }

            commandData.push(item.data);
        }),
    );

    client.on(Events.InteractionCreate, (interaction) => {
        if (interaction.isChatInputCommand()) slashCommandHandlers.get(interaction.commandName)?.(interaction);
        else if (interaction.isUserContextMenuCommand()) userCommandHandlers.get(interaction.commandName)?.(interaction);
        else if (interaction.isMessageContextMenuCommand()) messageCommandHandlers.get(interaction.commandName)?.(interaction);
        else if (interaction.isAutocomplete()) slashCommandAutocompletes.get(interaction.commandName)?.(interaction);
    });

    if (guildId) {
        const testGuild = client.guilds.resolve(guildId);
        if (!testGuild)
            throw new Error(`Provided test guild (${guildId}) can not be found, please make sure the bot you started this project on is in this guild.`);
        await testGuild.commands.set(commandData);
    } else {
        await client.application.commands.set(commandData);
    }
}

export async function loadInteractions(client: Client<true>, directory: string, argumentSeparator: string = ":") {
    const files = await fs.readdir(path.resolve(directory), { recursive: true, withFileTypes: true });

    const modalHandlers = new Map<string, Handler<ModalSubmitInteraction>>();
    const buttonHandlers = new Map<string, Handler<ButtonInteraction>>();
    const stringHandlers = new Map<string, Handler<StringSelectMenuInteraction>>();
    const userHandlers = new Map<string, Handler<UserSelectMenuInteraction>>();
    const roleHandlers = new Map<string, Handler<RoleSelectMenuInteraction>>();
    const mentionHandlers = new Map<string, Handler<MentionableSelectMenuInteraction>>();
    const channelHandlers = new Map<string, Handler<ChannelSelectMenuInteraction>>();

    await Promise.all(
        files.map(async (file) => {
            if (file.isDirectory()) return;

            const absolutePath = path.resolve(file.parentPath, file.name);
            const relativePath = path.relative(path.resolve(directory), absolutePath);
            const handlerKey = relativePath.replace(/\.[^/.]+$/, "");

            const { default: item } = await import(absolutePath).catch(() => null);

            if (item instanceof ModalHandler) modalHandlers.set(handlerKey, item.handler);
            else if (item instanceof ButtonHandler) buttonHandlers.set(handlerKey, item.handler);
            else if (item instanceof StringSelectHandler) stringHandlers.set(handlerKey, item.handler);
            else if (item instanceof UserSelectHandler) userHandlers.set(handlerKey, item.handler);
            else if (item instanceof RoleSelectHandler) roleHandlers.set(handlerKey, item.handler);
            else if (item instanceof MentionSelectHandler) mentionHandlers.set(handlerKey, item.handler);
            else if (item instanceof ChannelSelectHandler) channelHandlers.set(handlerKey, item.handler);
            else throw new Error(`Loading interactions failed: export from ${relativePath} was not an instance of <InteractionType>Handler.`);
        }),
    );

    client.on(Events.InteractionCreate, (interaction) => {
        if (!interaction.isMessageComponent() && !interaction.isModalSubmit()) return;

        const [, userId, path, ...args] = interaction.customId.split(argumentSeparator);
        if (!path || (userId && interaction.user.id !== userId)) return;

        if (interaction.isModalSubmit()) modalHandlers.get(path)?.(interaction, ...args);
        else if (interaction.isButton()) buttonHandlers.get(path)?.(interaction, ...args);
        else if (interaction.isStringSelectMenu()) stringHandlers.get(path)?.(interaction, ...args);
        else if (interaction.isUserSelectMenu()) userHandlers.get(path)?.(interaction, ...args);
        else if (interaction.isRoleSelectMenu()) roleHandlers.get(path)?.(interaction, ...args);
        else if (interaction.isMentionableSelectMenu()) mentionHandlers.get(path)?.(interaction, ...args);
        else if (interaction.isChannelSelectMenu()) channelHandlers.get(path)?.(interaction, ...args);
    });
}

export async function loadEvents(client: Client<true>, directory: string, recursive: boolean = false) {
    const files = await fs.readdir(path.resolve(directory), { recursive, withFileTypes: true });
    const handlers: Partial<{ [K in keyof ClientEvents]: ((...args: ClientEvents[K]) => unknown)[] }> = {};

    await Promise.all(
        files.map(async (file) => {
            if (file.isDirectory()) return;

            const absolutePath = path.resolve(file.parentPath, file.name);

            const { default: item } = await import(absolutePath);

            if (item instanceof EventHandler) (handlers[item.event as keyof ClientEvents] ??= []).push(item.handler);
            else {
                throw new Error(
                    `Loading events failed: export from ${path.relative(path.resolve(directory), absolutePath)} was not an instance of EventHandler<T>.`,
                );
            }
        }),
    );

    Object.entries(handlers).forEach(([key, handlers]) => client.on(key, (...args) => handlers.forEach((handler) => (handler as any)(...args))));
}
