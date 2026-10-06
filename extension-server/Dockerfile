FROM eclipse-temurin:21-jdk-alpine AS build
RUN apk add --no-cache git bash
WORKDIR /src
RUN git clone --depth 1 https://github.com/kodjodevf/M-Extension-Server.git .
RUN ./gradlew --no-daemon :server:shadowJar
FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY --from=build /src/server/build/MExtensionServer-v1.0.9-r*.jar /app/mextensionserver.jar
RUN mkdir -p /data
EXPOSE 8080
CMD ["java","-jar","/app/mextensionserver.jar","8080","/data"]
