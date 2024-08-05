import {AuthProvider, canBeIntraError, esc, IntraError, ModuleCode, RawIntra, RawIntraConfig} from 'epitech.js';
import * as process from "node:process";
import * as dotenv from "dotenv";
import axios, {AxiosInstance, AxiosRequestConfig} from "axios";
import {stringify} from "querystring";
import {InstanceCode} from "epitech.js/out/common";
import * as fs from "node:fs";

dotenv.config();
const token = process.env.INTRA_TOKEN as string;

class LocalAuthProvider implements AuthProvider {
    async refresh(): Promise<string> {
        console.log("Refreshing token...");
        return token;
    }
}

const intra = new RawIntra({});

export class MyIntraRequestProvider {
    protected endpoint = "https://intra.epitech.eu/";
    protected client: AxiosInstance;
    protected cookies: { [key: string]: string } = {};
    protected throwIntraError: boolean = true;
    protected authStrategy: string;
    protected provider: AuthProvider | undefined;
    protected debugPrintRequests: boolean;

    _initAutologin(autologin: string, authStrategy: string = "indirect") {
        let autologinUrl: string;
        try {
            if (/^auth-[a-fA-F0-9]+$/.test(autologin)) {
                autologinUrl = "https://intra.epitech.eu/" + autologin;
            } else {
                const url = new URL(autologin);
                if (!/^\/auth-[a-fA-F0-9]+\/?$/.test(url.pathname)) {
                    throw "Invalid path";
                }
                autologinUrl = "https://intra.epitech.eu" + url.pathname;
            }
        } catch (e) {
            throw new IntraError({message: "Invalid autologin: " + e});
        }

        this.authStrategy = authStrategy;

        if (authStrategy == "default")
            authStrategy = "indirect";

        if (authStrategy == "direct") {
            this.endpoint = autologinUrl;
        } else if (authStrategy == "indirect") {
            this.endpoint = "https://intra.epitech.eu/";
        } else {
            throw new IntraError({message: "Invalid auth strategy: " + authStrategy});
        }
        return autologinUrl;
    }

    constructor(config: RawIntraConfig) {
        let autologinUrl: string | undefined;
        this.authStrategy = config.autologinAuthStrategy ?? "default";
        this.debugPrintRequests = config.debugPrintRequests ?? false;
        if (typeof config.autologin !== "undefined") {
            autologinUrl = this._initAutologin(config.autologin, config.autologinAuthStrategy);
        }
        if (typeof config.provider !== "undefined") {
            this.provider = config.provider;
        }

        this.client = axios.create({
            validateStatus: (status) => status < 500,
            baseURL: this.endpoint.endsWith("/") ? this.endpoint.substring(0, this.endpoint.length - 1) : this.endpoint,
            timeout: 30 * 1000,
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });

        if (typeof this.provider !== "undefined") {
            this._initAuthProviderInterceptors();
        }
    }

    _initAuthProviderInterceptors() {
        let firstLoggedIn = false;

        this.client.interceptors.request.use(async (config) => {
            if (!firstLoggedIn) {
                const newCookies = await this._refreshCookiesFromProvider("refresh");
                firstLoggedIn = true;
                if (config.headers?.Cookie !== undefined) {
                    config.headers.Cookie = [
                        config.headers.Cookie,
                        ...newCookies
                    ].join(";");
                } else {
                    config.headers.Cookie = newCookies.join(";");
                }
            }
            return config;
        }, (error) => error);

        this.client.interceptors.response.use(async (response) => {
            const config: any = response.config;
            if (response.status === 403 && !config._retry) {
                const newCookies = await this._refreshCookiesFromProvider("refresh");
                config._retry = true;
                if (config.headers?.Cookie !== undefined) {
                    const oldCookies: string = config.headers.Cookie;
                    const newCookieKeys = newCookies.map(c => c.split("=")[0].trim());
                    config.headers.Cookie = [
                        oldCookies.split(";")
                            .filter(c => newCookieKeys.indexOf(c.split("=")[0].trim()) === -1)
                            .join(";"),
                        ...newCookies
                    ].join(";");
                } else {
                    if (!config.headers)
                        config.headers = {};
                    config.headers.Cookie = newCookies.join(";");
                }
                return this.client(config);
            }
            return response;
        }, (error) => error);
    }

    async _refreshCookiesFromProvider(method: "refresh") {
        if (this.provider === undefined) {
            throw new IntraError("No provider");
        }
        const userToken = await this.provider[method]();
        await this.setCookie("user", userToken);
        return ['user=' + userToken];
    }

    getClient() {
        return this.client;
    }

    async setTimezone(value: string) {
        await this.setCookie("tz", value);
    }

    disableThrowIntraError() {
        this.throwIntraError = false;
    }

    async setCookie(key: string, value: string) {
        let cookieString = "";

        this.cookies[key] = value;
        for (const key in this.cookies) {
            cookieString += esc`${key}=${this.cookies[key]}; `;
        }
        this.client.defaults.headers.common.Cookie = cookieString;
    }

    async get(route: string, config?: AxiosRequestConfig) {
        if (this.debugPrintRequests) {
            console.log("[epitech.js] req> GET " + route);
        }
        const out = await this.client.get(route, config);
        if (this.debugPrintRequests) {
            console.log("[epitech.js] res> " + JSON.stringify(out.data, undefined, 4).split("\n").join("\n[epitech.js] res> "));
        }
        if (this.throwIntraError && canBeIntraError(out.data)) {
            throw new IntraError(out.data);
        }
        return out;
    }

    async json(route: string, config?: AxiosRequestConfig) {
        if (route.includes("?")) {
            route += "&"
        } else {
            route += "?"
        }
        route += "format=json";

        const out = await this.get(route, config);
        if (this.throwIntraError && typeof out.data === "string") {
            throw new IntraError({
                error: "Invalid response",
                message: out.data
            });
        }
        if (this.throwIntraError && canBeIntraError(out.data)) {
            throw new IntraError(out.data);
        }
        return out;
    }

    async post(route: string, body: any, config?: AxiosRequestConfig) {
        if (route.includes("?")) {
            route += "&"
        } else {
            route += "?"
        }
        route += "format=json";

        body = body ? stringify(body) : undefined;

        if (this.debugPrintRequests) {
            console.log("[epitech.js] req> POST " + route);
            console.log("[epitech.js] req> " + body);
        }
        const out = await this.client.post(route, body, config);
        if (this.debugPrintRequests) {
            console.log("[epitech.js] res> " + JSON.stringify(out.data, undefined, 4).split("\n").join("\n[epitech.js] res> "));
        }
        if (this.throwIntraError && canBeIntraError(out.data)) {
            throw new IntraError(out.data);
        }
        return out;
    }

    async getStream(route: string, config?: AxiosRequestConfig) {
        if (this.debugPrintRequests) {
            console.log("[epitech.js] req> GET " + route);
        }
        return this.client.get(route, {
            responseType: "stream",
            headers: {
                "Accept": "application/octet-stream",
                "Content-Type": "application/octet-stream"
            },
            ...config
        });
    }
}

enum Week {
    A = 'A',
    B = 'B',
    C = 'C',
    UNKNOWN = 'UNKNOWN'
}

class Project {
    start!: Date;
    end!: Date;
    title!: string;

    constructor(partial?: Partial<Project>) {
        Object.assign(this, partial);
    }
}

class Day {
    title!: string;
    start!: Date;
    end!: Date;
    location!: string;

    constructor(partial?: Partial<Day>) {
        Object.assign(this, partial);
    }
}

class Module {
    inTeam: boolean = false;
    teamMin: number = 0;
    teamMax: number = 0;
    title: string = '';
    begin!: Date;
    end!: Date;
    endRegister!: Date;
    code!: ModuleCode;
    codeInstance!: InstanceCode;
    locationTitle!: string;
    instanceCodeLocation!: string;
    credits: number = 0;
    status!: string;
    open: boolean = false;
    inRemote: boolean = false;
    hasProgressiveCredits: boolean = false;
    project!: Project;
    link!: string
    days: Day[] = [];

    constructor(partial?: Partial<Module>) {
        Object.assign(this, partial);
    }
}

class Data {
    credits: number = 0;
    requiredCredits: number = 90;
    week: Week = Week.UNKNOWN;
    modules: Module[] = [];

    constructor(partial?: Partial<Data>) {
        Object.assign(this, partial);
    }
}

const main = async () => {
    // @ts-ignore
    intra.request = new MyIntraRequestProvider({
        provider: new LocalAuthProvider(),
        debugPrintRequests: false,
    });
    await intra.getRequestProvider().setTimezone("Europe/Paris");
    const cookies = "0bZPBRWI-hfikMlI5B_vE1fOvaQ=VrgKq5a-uY-cQeAHlNgeR0iu0dU; dQueXqAfH5_kdsD4XP7E2ZcTBv0=1722863277; NRskmpiqWTmDdFGNtCXH99AeexA=1722949677; Y7N4iJ9C-DlVlrSwDMkXpHX94as=rXMPqpN1B-3hEDNnCwc_anC9z6s; JjP4m3zjIOq_u7-hZThzceWwWcE=1vxYlrldm1uoeJ--m0x3UfgaLbk; CDKRkTsK0c02AeKWYkFyQYjk9ac=1722865025; pXVjG6VTUPvDGG8GyX6gPQLAsH0=1722951425; vPTX72f84yMdszYrt5IPz1ySr8I=S94Lm4tKW_BmuzPpSGHi9w6qtPA; gdpr=1";
    cookies.split(";").forEach(c => {
        intra.getRequestProvider().setCookie(c.split("=")[0].trim(), c.split("=")[1].trim());
    });

    const user = await intra.getUser();
    const scolarYear = user.scolaryear;
    const semester = user.semester; // should be nine or ten
    const semesterCode = user.semester_code.split('/')[1].split('-')[1] as Week // should be A, B or C
    const credits = user.credits;
    let codeinstance = "";
    const educationalOverview = await intra.getUserEducationalOverview(user.login);

    console.log(`User: ${user.login}`);
    console.log(`Scolar year: ${scolarYear}`);
    console.log(`Semester: ${semester}`);
    console.log(`Semester code: ${semesterCode}`);
    console.log(`Credits: ${credits}`);

    const courses = await intra.filterCourses({
        scolaryears: [parseInt(scolarYear)],
        locations: [user.location],
    })
    const filteredCourses = courses.items.filter(c => c.semester === semester);
    codeinstance = filteredCourses[0].codeinstance;

    const data = new Data({
        credits: credits,
        week: semesterCode,
    });

    for (let c of filteredCourses) {
        const fullCourse = await intra.getModule({scolaryear: c.scolaryear, module: c.code, instance: c.codeinstance});

        const module = new Module({
            codeInstance: fullCourse.codeinstance,
            credits: fullCourse.credits,
            open: Boolean(fullCourse.opened),
            begin: new Date(fullCourse.begin),
            end: new Date(fullCourse.end),
            endRegister: new Date(fullCourse.end_register),
            hasProgressiveCredits: fullCourse.flags === '2',
            instanceCodeLocation: fullCourse.instance_location,
            code: fullCourse.codemodule,
            locationTitle: c.location_title,
            link: `https://intra.epitech.eu/module/${c.scolaryear}/${c.code}/${c.codeinstance}/`,
            status: c.status,
            title: fullCourse.title,

            inTeam: false,
            inRemote: false,
            teamMax: 0,
            teamMin: 0,
        })
        const projectActivity = fullCourse.activites.find(a => a.type_code === 'proj');
        if (projectActivity) {
            const rawProject = await intra.getProject({
                scolaryear: c.scolaryear,
                module: c.code,
                instance: c.codeinstance,
                activity: projectActivity.codeacti
            })

            module.project = new Project({
                end: new Date(rawProject.deadline!),
                start: new Date(rawProject.begin!),
                title: rawProject.project_title,
            });
            module.teamMin = rawProject.nb_min;
            module.teamMax = rawProject.nb_max;
            module.inTeam = rawProject.nb_min > 1;
        } else {
            module.project = new Project({
                end: new Date(fullCourse.end),
                start: new Date(fullCourse.begin),
                title: "No Project",
            });
            console.error("No project found for module " + module.title);
        }

        const daysActivities = fullCourse.activites.filter(a => a.type_code === 'tp');
        if (daysActivities.length && daysActivities[0] && daysActivities[0].events.length && daysActivities[0].events[0])
            // @ts-ignore
            module.inRemote = daysActivities[0].events[0].location.toLocaleLowerCase().includes("visio");
        else
            module.inRemote = false;

        module.days = daysActivities.map(a => new Day({
            title: a.title,
            start: new Date(a.begin!),
            end: new Date(a.end!),
            location: a.events[0].location!,
        }));

        data.modules.push(module);

        console.log(`Module: ${module.title}`);
        console.log(`Credits: ${module.credits}`);
        console.log(`Team: ${module.teamMin} - ${module.teamMax}`);
        console.log(`Remote: ${module.inRemote}`);
        console.log(`Project: ${module.project.title}`);
        console.log(`Project start: ${module.project.start}`);
        console.log(`Project end: ${module.project.end}`);

        // break;
    }
    data.modules.sort((a, b) => a.begin.getTime() - b.begin.getTime());
    fs.writeFileSync("data.json", JSON.stringify(data, null, 2));

    let planning = await intra.getPlanning();
    planning = planning.filter(p => p.scolaryear === scolarYear && p.semester === semester && p.codeinstance === codeinstance);
    fs.writeFileSync("planning.json", JSON.stringify(planning, null, 2));
}

main().catch(console.error);
