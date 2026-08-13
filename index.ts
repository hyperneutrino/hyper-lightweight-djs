import {
    ApplicationCommandOptionType,
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
    type ApplicationCommandSubCommandData,
    type ApplicationCommandSubGroupData,
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
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

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

export class SlashCommand extends Command<Omit<ChatInputApplicationCommandData, "type">, ChatInputCommandInteraction, true> {}
export class UserCommand extends Command<Omit<UserApplicationCommandData, "type">, UserContextMenuCommandInteraction> {}
export class MessageCommand extends Command<Omit<MessageApplicationCommandData, "type">, MessageContextMenuCommandInteraction> {}

export class SlashCommandWithSubcommands {
    data: Omit<ChatInputApplicationCommandData, "options" | "type">;

    constructor(data: typeof this.data) {
        this.data = data;
    }
}

export class SubcommandGroup {
    data: Omit<ApplicationCommandSubGroupData, "options" | "type">;

    constructor(data: typeof this.data) {
        this.data = data;
    }
}

export class Subcommand {
    data: Omit<ApplicationCommandSubCommandData, "type">;
    handler: Handler<ChatInputCommandInteraction>;

    constructor({ handler, ...data }: typeof this.data & { handler: Subcommand["handler"] }) {
        this.data = data;
        this.handler = handler;
    }
}

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

async function importAll(
    { directory, recursive }: { directory: string; recursive: boolean },
    consumer: (data: { file: Dirent<string>; relativePath: string; absolutePath: string; item: unknown }) => unknown,
) {
    const files = await fs.readdir(path.resolve(directory), { recursive, withFileTypes: true });

    await Promise.all(
        files.map(async (file) => {
            if (file.isDirectory()) return;

            const absolutePath = path.resolve(file.parentPath, file.name);
            const relativePath = path.join(directory, path.relative(path.resolve(directory), absolutePath));

            const { default: item } = await import(absolutePath);

            await consumer({ file, relativePath, absolutePath, item });
        }),
    );
}

async function loadSubcommands(directory: string): Promise<{
    options: ApplicationCommandSubCommandData[];
    handlers: Map<string, Handler<ChatInputCommandInteraction>>;
}> {
    if (!(await fs.exists(directory))) throw new Error(`Loading subcommands within a group failed: ${directory} is required but could not be found.`);

    const options: ApplicationCommandSubCommandData[] = [];
    const handlers = new Map<string, Handler<ChatInputCommandInteraction>>();

    await importAll({ directory, recursive: false }, async ({ file, relativePath, item }) => {
        if (item instanceof Subcommand) {
            options.push({ ...item.data, type: ApplicationCommandOptionType.Subcommand });
            handlers.set(item.data.name, item.handler);
        } else throw new Error(`Loading commands failed: export from ${relativePath} (third-level in commands folder) was not an instance of Subcommand.`);

        if (item.data.name !== file.name.replace(/.[^/.]+$/, ""))
            throw new Error(`Code style enforcement: name exported from ${relativePath} does not match the filename`);
    });

    return { options, handlers };
}

async function loadSubcommandsAndGroups(directory: string): Promise<{
    options: (ApplicationCommandSubGroupData | ApplicationCommandSubCommandData)[];
    handler: Handler<ChatInputCommandInteraction>;
}> {
    if (!(await fs.exists(directory))) throw new Error(`Loading subcommands/groups failed: ${directory} is required but could not be found.`);

    const options: (ApplicationCommandSubGroupData | ApplicationCommandSubCommandData)[] = [];
    const handlers = new Map<string, Handler<ChatInputCommandInteraction>>();

    await importAll({ directory, recursive: false }, async ({ file, relativePath, item }) => {
        if (item instanceof Subcommand) {
            options.push({ ...item.data, type: ApplicationCommandOptionType.Subcommand });
            handlers.set(`/${item.data.name}`, item.handler);
        } else if (item instanceof SubcommandGroup) {
            const subcommands = await loadSubcommands(relativePath.replace(/\.[^/.]+$/, ""));
            options.push({ ...item.data, type: ApplicationCommandOptionType.SubcommandGroup, options: subcommands.options });
            subcommands.handlers.entries().forEach(([key, handler]) => handlers.set(`${item.data.name}/${key}`, handler));
        } else
            throw new Error(
                `Loading commands failed: export from ${relativePath} (second-level in commands folder) was not an instance of SubcommandGroup or Subcommand.`,
            );

        if (item.data.name !== file.name.replace(/.[^/.]+$/, ""))
            throw new Error(`Code style enforcement: name exported from ${relativePath} does not match the filename`);
    });

    return {
        options,
        handler: (cmd) => handlers.get(`${cmd.options.getSubcommandGroup(false) ?? ""}/${cmd.options.getSubcommand(true)}`)?.(cmd),
    };
}

export async function loadCommands(client: Client<true>, directory: string, guildId?: string) {
    const commandData: (ChatInputApplicationCommandData | UserApplicationCommandData | MessageApplicationCommandData)[] = [];

    const slashCommandHandlers = new Map<string, Handler<ChatInputCommandInteraction>>();
    const userCommandHandlers = new Map<string, Handler<UserContextMenuCommandInteraction>>();
    const messageCommandHandlers = new Map<string, Handler<MessageContextMenuCommandInteraction>>();

    const slashCommandAutocompletes = new Map<string, Handler<AutocompleteInteraction>>();

    await importAll({ directory, recursive: false }, async ({ file, relativePath, item }) => {
        if (item instanceof SlashCommand) {
            commandData.push({ ...item.data, type: ApplicationCommandType.ChatInput });
            slashCommandHandlers.set(item.data.name, item.handler);
            if (item.autocomplete) slashCommandAutocompletes.set(item.data.name, item.autocomplete);
        } else if (item instanceof UserCommand) {
            commandData.push({ ...item.data, type: ApplicationCommandType.User });
            userCommandHandlers.set(item.data.name, item.handler);
        } else if (item instanceof MessageCommand) {
            commandData.push({ ...item.data, type: ApplicationCommandType.Message });
            messageCommandHandlers.set(item.data.name, item.handler);
        } else if (item instanceof SlashCommandWithSubcommands) {
            const { options, handler } = await loadSubcommandsAndGroups(relativePath.replace(/\.[^/.]+$/, ""));
            commandData.push({ ...item.data, options });
            slashCommandHandlers.set(item.data.name, handler);
        } else {
            throw new Error(`Loading commands failed: export from ${relativePath} was not an instance of <Type>Command.`);
        }

        if (item.data.name !== file.name.replace(/.[^/.]+$/, ""))
            throw new Error(`Code style enforcement: name exported from ${relativePath} does not match the filename`);
    });

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

    return { commands: commandData, slashCommandHandlers, userCommandHandlers, messageCommandHandlers };
}

export async function loadInteractions(client: Client, directory: string, argumentSeparator: string = ":") {
    const modalHandlers = new Map<string, Handler<ModalSubmitInteraction>>();
    const buttonHandlers = new Map<string, Handler<ButtonInteraction>>();
    const stringSelectHandlers = new Map<string, Handler<StringSelectMenuInteraction>>();
    const userSelectHandlers = new Map<string, Handler<UserSelectMenuInteraction>>();
    const roleSelectHandlers = new Map<string, Handler<RoleSelectMenuInteraction>>();
    const mentionSelectHandlers = new Map<string, Handler<MentionableSelectMenuInteraction>>();
    const channelSelectHandlers = new Map<string, Handler<ChannelSelectMenuInteraction>>();

    await importAll({ directory, recursive: true }, async ({ relativePath, item }) => {
        const handlerKey = relativePath.replace(/\.[^/.]+$/, "").replace(/\\/g, "/");

        if (item instanceof ModalHandler) modalHandlers.set(handlerKey, item.handler);
        else if (item instanceof ButtonHandler) buttonHandlers.set(handlerKey, item.handler);
        else if (item instanceof StringSelectHandler) stringSelectHandlers.set(handlerKey, item.handler);
        else if (item instanceof UserSelectHandler) userSelectHandlers.set(handlerKey, item.handler);
        else if (item instanceof RoleSelectHandler) roleSelectHandlers.set(handlerKey, item.handler);
        else if (item instanceof MentionSelectHandler) mentionSelectHandlers.set(handlerKey, item.handler);
        else if (item instanceof ChannelSelectHandler) channelSelectHandlers.set(handlerKey, item.handler);
        else throw new Error(`Loading interactions failed: export from ${relativePath} was not an instance of <InteractionType>Handler.`);
    });

    client.on(Events.InteractionCreate, (interaction) => {
        if (!interaction.isMessageComponent() && !interaction.isModalSubmit()) return;

        const [, userId, path, ...args] = interaction.customId.split(argumentSeparator);
        if (!path || (userId && interaction.user.id !== userId)) return;

        if (interaction.isModalSubmit()) modalHandlers.get(path)?.(interaction, ...args);
        else if (interaction.isButton()) buttonHandlers.get(path)?.(interaction, ...args);
        else if (interaction.isStringSelectMenu()) stringSelectHandlers.get(path)?.(interaction, ...args);
        else if (interaction.isUserSelectMenu()) userSelectHandlers.get(path)?.(interaction, ...args);
        else if (interaction.isRoleSelectMenu()) roleSelectHandlers.get(path)?.(interaction, ...args);
        else if (interaction.isMentionableSelectMenu()) mentionSelectHandlers.get(path)?.(interaction, ...args);
        else if (interaction.isChannelSelectMenu()) channelSelectHandlers.get(path)?.(interaction, ...args);
    });

    return { modalHandlers, buttonHandlers, stringSelectHandlers, userSelectHandlers, roleSelectHandlers, mentionSelectHandlers, channelSelectHandlers };
}

export async function loadEvents(client: Client, directory: string, recursive: boolean = false) {
    const handlers: Partial<{ [K in keyof ClientEvents]: ((...args: ClientEvents[K]) => unknown)[] }> = {};
    const filenames: Partial<{ [K in keyof ClientEvents]: string[] }> = {};

    await importAll({ directory, recursive }, async ({ relativePath, item }) => {
        if (item instanceof EventHandler) {
            (handlers[item.event as keyof ClientEvents] ??= []).push(item.handler);
            (filenames[item.event as keyof ClientEvents] ??= []).push(path.relative(directory, relativePath));
        } else {
            throw new Error(`Loading events failed: export from ${relativePath} was not an instance of EventHandler<T>.`);
        }
    });

    Object.entries(handlers).forEach(([key, handlers]) => client.on(key, (...args) => handlers.forEach((handler) => (handler as any)(...args))));

    return { handlers, filenames };
}
