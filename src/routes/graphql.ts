import {
    formatError,
    GraphQLObjectType,
    GraphQLNonNull,
    GraphQLString,
    GraphQLList,
    GraphQLSchema,
    GraphQLID,
    GraphQLFieldConfigArgumentMap,
    GraphQLInt,
    GraphQLInputObjectType,
    execute,
} from 'graphql'
import graphQLHTTPServer, { OptionsData } from 'express-graphql'
import * as pg from 'pg'
import { listRepositories, validateRepository, validateCommit } from '../git'
import sql from 'sql-template-strings'
import { Loaders, createLoaders, ForwardConnectionArguments } from '../loaders'
import {
    Location,
    CodeSmell,
    UUID,
    RepoSpec,
    CommitSpec,
    FileSpec,
    Range,
    File,
    CodeSmellLifespan,
    Commit,
    Signature,
    RepoRootSpec,
    CodeSmellInput,
} from '../models'
import { transaction, mapConnectionNodes, logDuration } from '../util'
import { Duration, ZonedDateTime } from '@js-joda/core'
import * as chardet from 'chardet'
import { connectionDefinitions, forwardConnectionArgs, Connection, connectionFromArray } from 'graphql-relay'
import { last } from 'lodash'

interface Context {
    loaders: Loaders
}

export interface GraphQLHandler {
    rootValue: unknown
    schema: GraphQLSchema
}
export function createGraphQLHandler({ db, repoRoot }: { db: pg.Client; repoRoot: string }): GraphQLHandler {
    var encodingArg: GraphQLFieldConfigArgumentMap = {
        encoding: {
            type: GraphQLString,
            description: 'Encoding to use. If not given, will try to auto-detect, otherwise default to UTF8.',
        },
    }

    var SignatureType = new GraphQLObjectType<Signature>({
        name: 'Signature',
        fields: {
            name: { type: GraphQLNonNull(GraphQLString) },
            email: { type: GraphQLNonNull(GraphQLString) },
            date: { type: GraphQLNonNull(GraphQLString) },
        },
    })

    var CommitType: GraphQLObjectType = new GraphQLObjectType<Commit>({
        name: 'Commit',
        fields: () => ({
            sha: { type: GraphQLNonNull(GraphQLString) },
            message: { type: GraphQLNonNull(GraphQLString) },
            author: { type: GraphQLNonNull(SignatureType) },
            committer: { type: GraphQLNonNull(SignatureType) },
            parents: { type: GraphQLNonNull(GraphQLList(GraphQLNonNull(CommitType))) },
            files: {
                args: forwardConnectionArgs,
                type: GraphQLNonNull(FileConnectionType),
                description: 'The files that existed at this commit in the repository',
            },
            codeSmells: {
                type: GraphQLNonNull(CodeSmellConnectionType),
                args: forwardConnectionArgs,
            },
        }),
    })
    var { connectionType: CommitConnectionType } = connectionDefinitions({ nodeType: CommitType })

    var FileType = new GraphQLObjectType<File>({
        name: 'File',
        fields: {
            path: { type: GraphQLNonNull(GraphQLString) },
            content: {
                type: GraphQLString,
                args: encodingArg,
                description:
                    'The file content from the git repository. null if the repository was not uploaded.',
            },
            linesCount: { type: GraphQLInt },
            commit: { type: GraphQLNonNull(CommitType) },
        },
    })
    var { connectionType: FileConnectionType } = connectionDefinitions({ nodeType: FileType })

    var positionFields = {
        line: {
            type: GraphQLNonNull(GraphQLInt),
            description: 'The 0-based line number of the position',
        },
        character: {
            type: GraphQLNonNull(GraphQLInt),
            description: 'The 0-based character number of the position',
        },
    }
    var PositionType = new GraphQLObjectType({
        name: 'Position',
        fields: positionFields,
    })
    var PositionInputType = new GraphQLInputObjectType({
        name: 'PositionInput',
        fields: positionFields,
    })

    var rangeFields = <P extends GraphQLObjectType | GraphQLInputObjectType>(positionType: P) => ({
        start: {
            type: GraphQLNonNull(positionType),
            description: 'The start position of the range, inclusive.',
        },
        end: {
            type: GraphQLNonNull(positionType),
            description: 'The end position of the range, exclusive.',
        },
    })

    var RangeType = new GraphQLObjectType({
        name: 'Range',
        fields: rangeFields(PositionType),
    })
    var RangeInputType = new GraphQLInputObjectType({
        name: 'RangeInput',
        fields: rangeFields(PositionInputType),
    })

    var LocationType = new GraphQLObjectType({
        name: 'Location',
        fields: {
            file: {
                type: GraphQLNonNull(FileType),
            },
            range: {
                type: RangeType,
            },
            content: {
                type: GraphQLString,
                args: encodingArg,
                description: 'The content of the range.',
            },
        },
    })
    var LocationInputType = new GraphQLInputObjectType({
        name: 'LocationInput',
        fields: {
            file: {
                type: GraphQLNonNull(GraphQLString),
                description: 'The file path of the location.',
            },
            range: {
                type: RangeInputType,
            },
        },
    })

    var CodeSmellType: GraphQLObjectType = new GraphQLObjectType({
        name: 'CodeSmell',
        fields: () => ({
            id: {
                type: GraphQLNonNull(GraphQLID),
            },
            message: {
                type: GraphQLString,
                description: 'A message for this specific code smell instance.',
            },
            locations: {
                type: GraphQLList(GraphQLNonNull(LocationType)),
            },
            lifeSpan: {
                type: GraphQLNonNull(CodeSmellLifeSpanType),
                description: 'The complete lifespan of this code smell throughout commit history.',
            },
            predecessor: {
                type: CodeSmellType,
                description:
                    'This code smell in a previous commit. This may not be in the direct parent commit because not every commit must be analyzed, but it is guaranteed to be in an ascendant commit.',
            },
            successor: {
                type: CodeSmellType,
                description:
                    'This code smell in a later commit. This may not be in the direct child commit because not every commit must be analyzed, but it is guaranteed to be in a descendant commit.',
            },
            commit: {
                type: CommitType,
                description: 'The commit this code smell was detected in.',
            },
        }),
    })
    var { connectionType: CodeSmellConnectionType } = connectionDefinitions({ nodeType: CodeSmellType })

    var CodeSmellLifeSpanType = new GraphQLObjectType({
        name: 'CodeSmellLifeSpan',
        description: 'A lifespan of a code smell throughout commit history.',
        fields: {
            id: {
                type: GraphQLNonNull(GraphQLID),
            },
            kind: {
                type: GraphQLString,
            },
            instances: {
                args: forwardConnectionArgs,
                type: GraphQLNonNull(CodeSmellConnectionType),
                description: 'The instances of the code smell throughout commit history.',
            },
            duration: {
                type: GraphQLNonNull(GraphQLString),
                description:
                    'The duration this code smell was present in the codebase as an ISO8601 duration string',
            },
            interval: {
                type: GraphQLNonNull(GraphQLString),
                description:
                    'The interval this code smell was present in the codebase as an ISO8601 interval string with start/end',
            },
        },
    })

    var { connectionType: CodeSmellLifespanConnectionType } = connectionDefinitions({
        nodeType: CodeSmellLifeSpanType,
    })

    var RepositoryType = new GraphQLObjectType({
        name: 'Repository',
        fields: {
            name: { type: GraphQLString },
            commits: {
                args: {
                    ...forwardConnectionArgs,
                    grep: {
                        type: GraphQLString,
                        description:
                            'Limit the commits to ones with log message that matches the specified pattern (regular expression).',
                    },
                },
                type: GraphQLNonNull(CommitConnectionType),
            },
            commit: {
                type: CommitType,
                args: {
                    sha: {
                        type: GraphQLNonNull(GraphQLString),
                    },
                },
                // resolve: (source: RepoSpec, { sha }: { sha: string }, { loaders }: Context) => {
                //     return loaders.commit.load({ ...source, commit: sha })
                // },
            },
            codeSmellLifespans: {
                args: {
                    ...forwardConnectionArgs,
                    kind: {
                        type: GraphQLString,
                    },
                },
                type: GraphQLNonNull(CodeSmellLifespanConnectionType),
            },
        },
    })
    var { connectionType: RepositoryConnectionType } = connectionDefinitions({
        nodeType: RepositoryType,
    })

    var CodeSmellInputType = new GraphQLInputObjectType({
        name: 'CodeSmellInput',
        fields: {
            lifespan: {
                type: GraphQLNonNull(GraphQLID),
                description:
                    'A client-provided ID to associate code smell instances in multiple commits as part of the same code smell lifespan',
            },
            ordinal: {
                type: GraphQLNonNull(GraphQLInt),
            },
            kind: {
                type: GraphQLNonNull(GraphQLString),
                description:
                    'An arbitrary string that uniquely identifies the kind of code smell, e.g. "GodClass". Must be the same for every instance.',
            },
            message: {
                type: GraphQLString,
                description:
                    'A message for the code smell, which can be specific to this particular instance.',
            },
            locations: {
                type: GraphQLList(GraphQLNonNull(LocationInputType)),
                description: 'Locations of the code smell in the code.',
            },
        },
    })

    const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
            name: 'Query',
            fields: {
                codeSmell: {
                    type: CodeSmellType,
                    args: {
                        id: {
                            type: GraphQLNonNull(GraphQLID),
                            description: 'The ID of the code smell to query.',
                        },
                    },
                },
                repository: {
                    type: RepositoryType,
                    args: {
                        name: {
                            type: GraphQLNonNull(GraphQLString),
                            description: 'The name under which the repository was uploaded.',
                        },
                    },
                },
                repositories: {
                    args: forwardConnectionArgs,
                    type: GraphQLNonNull(RepositoryConnectionType),
                },
            },
        }),
        mutation: new GraphQLObjectType({
            name: 'Mutation',
            fields: {
                addCodeSmells: {
                    args: {
                        repository: {
                            type: GraphQLNonNull(GraphQLString),
                        },
                        commit: {
                            type: GraphQLNonNull(GraphQLString),
                        },
                        codeSmells: {
                            type: GraphQLNonNull(GraphQLList(GraphQLNonNull(CodeSmellInputType))),
                        },
                    },
                    type: GraphQLNonNull(GraphQLList(GraphQLNonNull(CodeSmellType))),
                },
            },
        }),
    })

    class RepositoryResolver {
        constructor(public name: string) {}

        async commits(
            args: ForwardConnectionArguments & { grep?: string },
            { loaders }: Context
        ): Promise<Connection<CommitResolver>> {
            const connection = await loaders.commit.forRepository.load({
                ...args,
                repository: this.name,
            })
            return mapConnectionNodes(connection, node =>
                createCommitResolver({ repository: this.name }, node)
            )
        }

        async commit({ sha }: { sha: string }, { loaders }: Context) {
            const commit = await loaders.commit.bySha.load({ repository: this.name, commit: sha })
            return createCommitResolver({ repository: this.name }, commit)
        }

        async codeSmellLifespans(
            { kind, ...args }: { kind?: string | null } & ForwardConnectionArguments,
            { loaders }: Context
        ): Promise<Connection<CodeSmellLifeSpanResolver>> {
            const connection = await loaders.codeSmellLifespan.forRepository.load({
                ...args,
                repository: this.name,
                kind: kind || undefined,
            })
            return mapConnectionNodes(connection, node => new CodeSmellLifeSpanResolver(node))
        }
    }

    class CodeSmellLifeSpanResolver {
        constructor(private lifespan: CodeSmellLifespan) {}

        get id(): UUID {
            return this.lifespan.id
        }

        get kind(): string {
            return this.lifespan.kind
        }

        async duration(args: {}, { loaders }: Context): Promise<string> {
            const { repository, id: lifespan } = this.lifespan
            const instances = (await loaders.codeSmell.forLifespan.load({ lifespan }))!
            const start = (await loaders.commit.bySha.load({
                repository,
                commit: instances.edges[0].node.commit,
            }))!.committer.date
            const end = (await loaders.commit.bySha.load({
                repository,
                commit: last(instances.edges)!.node.commit,
            }))!.committer.date
            return Duration.between(ZonedDateTime.parse(start), ZonedDateTime.parse(end)).toString()
        }

        async interval(args: {}, { loaders }: Context): Promise<string> {
            const { repository, id: lifespan } = this.lifespan
            const instances = (await loaders.codeSmell.forLifespan.load({ lifespan }))!
            const start = (await loaders.commit.bySha.load({
                repository,
                commit: instances.edges[0].node.commit,
            }))!.committer.date
            const end = (await loaders.commit.bySha.load({
                repository,
                commit: last(instances.edges)!.node.commit,
            }))!.committer.date
            return `${start}/${end}`
        }

        async instances(
            args: ForwardConnectionArguments,
            { loaders }: Context
        ): Promise<Connection<CodeSmellResolver>> {
            const { pageInfo, edges } = await loaders.codeSmell.forLifespan.load({
                lifespan: this.lifespan.id,
                ...args,
            })
            return {
                pageInfo,
                edges: edges.map(({ node, cursor }) => ({ cursor, node: new CodeSmellResolver(node) })),
            }
        }
    }

    class CodeSmellResolver {
        constructor(private codeSmell: CodeSmell) {}
        get id(): UUID {
            return this.codeSmell.id
        }
        get message(): string {
            return this.codeSmell.message
        }
        async lifeSpan(args: {}, { loaders }: Context) {
            const lifespan = (await loaders.codeSmellLifespan.byId.load(this.codeSmell.lifespan))!
            return new CodeSmellLifeSpanResolver(lifespan)
        }
        async predecessor(args: {}, { loaders }: Context): Promise<CodeSmellResolver | null> {
            const codeSmell = await loaders.codeSmell.byOrdinal.load({
                lifespan: this.codeSmell.lifespan,
                ordinal: this.codeSmell.ordinal - 1,
            })
            return new CodeSmellResolver(codeSmell)
        }

        async successor(args: {}, { loaders }: Context): Promise<CodeSmellResolver | null> {
            const codeSmell = await loaders.codeSmell.byOrdinal.load({
                lifespan: this.codeSmell.lifespan,
                ordinal: this.codeSmell.ordinal + 1,
            })
            return new CodeSmellResolver(codeSmell)
        }

        async commit(args: {}, { loaders }: Context): Promise<CommitResolver> {
            const { repository } = (await loaders.codeSmellLifespan.byId.load(this.codeSmell.lifespan))!
            const commit = await loaders.commit.bySha.load({ repository, commit: this.codeSmell.commit })
            return createCommitResolver({ repository }, commit)
        }

        async locations(args: {}, { loaders }: Context) {
            const { repository } = (await loaders.codeSmellLifespan.byId.load(this.codeSmell.lifespan))!
            return this.codeSmell.locations.map(
                location => new LocationResolver({ ...location, ...this.codeSmell, repository })
            )
        }
    }

    class LocationResolver {
        constructor(private spec: Location & RepoSpec & CommitSpec) {}
        file(): FileResolver {
            return new FileResolver(this.spec)
        }
        range(): Range {
            return this.spec.range
        }
        async content({ encoding }: { encoding: string }, { loaders }: Context): Promise<string> {
            const buffer = await loaders.fileContent.load(this.spec)
            const { start, end } = this.spec.range
            const decoder = new TextDecoder(encoding || chardet.detect(buffer) || undefined)
            const content = decoder.decode(buffer)
            const lines = content.split('\n').slice(start.line, end.line + 1)
            if (lines.length === 0) {
                return ''
            }
            if (lines.length === 1) {
                return lines[0].slice(start.character, end.character)
            }
            lines[0] = lines[0].slice(start.character)
            lines[lines.length - 1] = lines[lines.length - 1].slice(end.character)
            return lines.join('\n')
        }
    }

    const createCommitResolver = ({ repository }: RepoSpec, commit: Commit) => {
        const spec = { repository, commit: commit.sha }
        return {
            ...commit,
            repository: () => new RepositoryResolver(repository),
            subject: (): string => commit.message.split('\n', 1)[0],
            async codeSmells(
                args: ForwardConnectionArguments,
                { loaders }: Context
            ): Promise<Connection<CodeSmellResolver>> {
                const connection = await loaders.codeSmell.forCommit.load({ ...spec, ...args })
                return mapConnectionNodes(connection, node => new CodeSmellResolver(node))
            },
            async files(
                args: ForwardConnectionArguments,
                { loaders }: Context
            ): Promise<Connection<FileResolver>> {
                const files = await loaders.files.load({ repository, commit: commit.sha })

                return connectionFromArray(
                    files.map(file => new FileResolver({ ...spec, file: file.path })),
                    args
                )
            },
        }
    }
    type CommitResolver = ReturnType<typeof createCommitResolver>

    class FileResolver {
        constructor(private spec: FileSpec & RepoSpec & CommitSpec) {}

        path(): string {
            return this.spec.file
        }

        async content({ encoding }: { encoding: string }, { loaders }: Context): Promise<string> {
            const content = await loaders.fileContent.load(this.spec)
            const decoder = new TextDecoder(encoding || chardet.detect(content) || undefined)
            return decoder.decode(content)
        }

        async commit(args: {}, { loaders }: Context) {
            const commit = await loaders.commit.bySha.load(this.spec)
            return createCommitResolver(this.spec, commit)
        }

        async linesCount(args: {}, { loaders }: Context) {
            const buffer = await loaders.fileContent.load(this.spec)
            const decoder = new TextDecoder(chardet.detect(buffer) || undefined)
            const str = decoder.decode(buffer)
            return str.split('\n').length
        }
    }

    const query = {
        repository({ name }: { name: string }) {
            return new RepositoryResolver(name)
        },
        async repositories(args: ForwardConnectionArguments): Promise<Connection<RepositoryResolver>> {
            const repositoryNames = await listRepositories({ repoRoot })
            return connectionFromArray(
                repositoryNames.map(name => new RepositoryResolver(name)),
                args
            )
        },
        async codeSmell({ id }: { id: UUID }, { loaders }: Context) {
            const codeSmell = await loaders.codeSmell.byId.load(id)
            return new CodeSmellResolver(codeSmell)
        },
    }

    const mutation = {
        async addCodeSmells(
            {
                repository,
                commit,
                codeSmells,
            }: {
                repository: string
                commit: string
                codeSmells: CodeSmellInput[]
            },
            { loaders }: Context
        ): Promise<CodeSmellResolver[]> {
            await validateRepository({ repository, repoRoot })
            await validateCommit({ repository, commit, repoRoot })

            return transaction(db, () =>
                Promise.all(
                    codeSmells.map(async ({ kind, message, locations, lifespan, ordinal }) => {
                        const locationsJson = JSON.stringify(locations)
                        // Get or create lifespan with ID passed from client
                        const lifespanResult = await db.query<{ id: UUID }>(sql`
                            insert into code_smell_lifespans (id, kind, repository)
                            values (${lifespan}, ${kind}, ${repository})
                            on conflict on constraint code_smell_lifespans_pkey do nothing
                            returning id
                        `)
                        const lifespanId = lifespanResult.rows[0]?.id ?? lifespan // if not defined, it already existed
                        const result = await db.query<CodeSmell>(sql`
                            insert into code_smells
                                        ("commit", "message", locations, lifespan, ordinal)
                            values      (${commit}, ${message}, ${locationsJson}::jsonb, ${lifespanId}, ${ordinal})
                            returning   id, "commit", "message", locations, lifespan, ordinal
                        `)
                        const codeSmell = result.rows[0]
                        loaders.codeSmell.byId.prime(codeSmell.id, codeSmell)
                        loaders.codeSmell.byOrdinal.prime(codeSmell, codeSmell)
                        return new CodeSmellResolver(codeSmell)
                    })
                )
            )
        },
    }

    const rootValue = {
        ...query,
        ...mutation,
    }

    return { schema, rootValue }
}

export const createGraphQLContext = (options: { db: pg.Client } & RepoRootSpec) => ({
    loaders: createLoaders(options),
})

export const createGraphQLHTTPHandler = (options: GraphQLHandler & { db: pg.Client } & RepoRootSpec) =>
    graphQLHTTPServer(() => ({
        ...options,
        customExecuteFn: logDuration('graphql.execute', args => Promise.resolve(execute(args))),
        context: createGraphQLContext(options),
        graphiql: true,
        customFormatErrorFn: err => {
            console.error(err.originalError)
            return {
                name: err.originalError ? err.originalError.name : err.name,
                ...formatError(err),
                stack: err.stack!.split('\n'),
            }
        },
    }))
