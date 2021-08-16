import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AllExceptionsFilter } from './dispatchers/exception.filter';
import { ValidationPipe } from './dispatchers/validation.pipe';

async function bootstrap() {
    // initialize environment
    require('dotenv').config();

    const app = await NestFactory.create(AppModule);

    // initialize global request validation
    app.useGlobalPipes(new ValidationPipe());

    // initialize global exception filter
    app.useGlobalFilters(new AllExceptionsFilter());

    app.enableCors();
    app.setGlobalPrefix('api/v1');

    // initialize swagger
    const options = new DocumentBuilder()
        .setTitle('Slot backend')
        .setDescription('Slotbackend API')
        .setBasePath('api/v1')
        .setVersion('1.0')
        .addTag('Slot Backend')
        .setSchemes('http')
        .build();
    const document = SwaggerModule.createDocument(app, options);
    SwaggerModule.setup('api', app, document, {
        customSiteTitle: 'Slot Backend',
    });

    await app.listen(8000);
}
bootstrap();
