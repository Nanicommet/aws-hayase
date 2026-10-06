FROM eclipse-temurin:21-jdk-alpine AS build
RUN apk add --no-cache git bash
# Pin with M_EXT_REF (tag or commit) in .env once you have a build you trust.
ARG M_EXT_REF=
WORKDIR /src
RUN git clone https://github.com/kodjodevf/M-Extension-Server.git . \
 && if [ -n "$M_EXT_REF" ]; then git checkout "$M_EXT_REF"; fi
RUN ./gradlew --no-daemon :server:shadowJar
# Version-agnostic: take the largest (fat) jar instead of hard-coding a version.
RUN mkdir /out && cp "$(ls -S server/build/MExtensionServer-*.jar | head -n1)" /out/mextensionserver.jar

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY --from=build /out/mextensionserver.jar /app/mextensionserver.jar
RUN mkdir -p /data
EXPOSE 8080
CMD ["java","-jar","/app/mextensionserver.jar","8080","/data"]
